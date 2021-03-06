/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * IP model
 */

'use strict';

var assert = require('assert-plus');
var common = require('./common');
var constants = require('../../util/constants');
var errors = require('../../util/errors');
var fmt = require('util').format;
var IP = common.IP;
var jsprim = require('jsprim');
var mod_moray = require('../../apis/moray');
var restify = require('restify');
var util_ip = require('../../util/ip');
var validate = require('../../util/validate');


// --- Globals



// Parameters used for creating a new nic object. Some are optional.
var CREATE_PARAMS = [
    'belongs_to_type',
    'belongs_to_uuid',
    'check_owner',
    'ip',
    'network',
    'network_uuid',
    'owner_uuid',
    'reserved'
];
// Parameters that are shared with nics
var NIC_SHARED_PARAMS = [
    'belongs_to_type',
    'belongs_to_uuid',
    'check_owner',
    'owner_uuid',
    'reserved'
];


// --- Schema validation objects

var LIST_SCHEMA = {
    strict: true,
    required: {
        network_uuid: validate.UUID
    },
    optional: {
        belongs_to_type: validate.string,
        belongs_to_uuid: validate.UUID,
        owner_uuid: validate.UUID,
        limit: validate.limit,
        offset: validate.offset
    }
};

var OWNING_FIELDS = [ 'belongs_to_uuid', 'belongs_to_type', 'owner_uuid' ];
var CREATE_SCHEMA = {
    required: {
        ip: validate.IP,
        network: validateNetworkObj,
        // We've already validated this courtesy of whoever called us
        // (they would have used network_uuid to validate the network
        // object above), but we want it in the validated params to
        // put in the IP object:
        network_uuid: validate.UUID
    },
    optional: {
        check_owner: validate.bool,
        belongs_to_uuid: validate.UUID,
        belongs_to_type: validate.string,
        owner_uuid: validate.UUID,
        reserved: validate.bool
    },
    after: [
        function _requireOwningInfo(_opts, _params, validated, callback) {
            var errs = [];
            if (validated.hasOwnProperty('belongs_to_uuid') ||
                validated.hasOwnProperty('belongs_to_type')) {
                OWNING_FIELDS.forEach(function (field) {
                    if (!validated.hasOwnProperty(field)) {
                        errs.push(errors.missingParam(field));
                    }
                });
            }

            if (errs.length > 0) {
                callback(errs);
                return;
            }

            callback();
        },
        validateNetworkOwner
    ]
};

// --- Internal helpers


/**
 * Validates that a network object is present
 */
function validateNetworkObj(_, name, net, callback) {
    if (!net || typeof (net) !== 'object') {
        return callback(errors.invalidParam(name,
            'could not find network'));
    }

    return callback(null, net);
}


/**
 * If we are attempting to add or update owner_uuid, ensure that it
 * matches the network
 */
function validateNetworkOwner(_opts, _, validated, callback) {
    if (!validated.network) {
        // We've already failed to validate the network - just return
        return callback();
    }

    if (validated.owner_uuid &&
        (!validated.hasOwnProperty('check_owner') ||
        validated.check_owner) &&
        !validated.network.isOwner(validated.owner_uuid)) {
        return callback(errors.invalidParam('owner_uuid',
            constants.OWNER_MATCH_MSG));
    }

    callback();
}

/*
 * The `free` and `unassign` property can't be set to `true` at the same time.
 */
function validateFreeUnassign(_opts, _, validated, callback) {
    if (validated.free && validated.unassign) {
        return callback(errors.invalidParam('unassign',
            constants.FREE_UNASSIGN_MSG));
    }

    callback();
}



// --- Exports



/*
 * List IPs in a network
 *
 * @param app {App}
 * @param log {Log}
 * @param oparams {Object}:
 * - `network_uuid`: Network UUID (required)
 * @param callback {Function} `function (err, ips)`
 */
function listNetworkIPs(app, log, oparams, callback) {
    log.debug({ params: oparams }, 'listNetworkIPs: entry');
    var bucket = common.getBucketObj(oparams.network_uuid);
    var lookupBy;
    var ips = [];
    var vparams;

    if (oparams.network.ip_use_strings) {
        lookupBy = 'ipaddr';
    } else {
        lookupBy = 'ip';
    }
    vparams = jsprim.deepCopy(oparams);
    delete vparams.network;

    validate.params(LIST_SCHEMA, null, vparams, function (valerr, params) {
        var lim, off;

        if (valerr) {
            return callback(valerr);
        }

        if (params.hasOwnProperty('limit')) {
            lim = params.limit;
            delete params.limit;
        } else {
            lim = constants.DEFAULT_LIMIT;
        }

        if (params.hasOwnProperty('offset')) {
            off = params.offset;
            delete params.offset;
        } else {
            off = constants.DEFAULT_OFFSET;
        }

        var listOpts = {
            limit: lim,
            offset: off,
            sort: {
                attribute: lookupBy,
                order: 'ASC'
            }
        };

        var req = app.moray.findObjects(bucket.name,
            mod_moray.filter(params, bucket) || fmt('(%s=*)', lookupBy),
            listOpts);

        req.on('error', function _onNetListErr(err) {
            return callback(err);
        });

        req.on('record', function _onNetListRec(rec) {
            rec.value.network = oparams.network;
            rec.value.network_uuid = params.network_uuid;
            var ip = new IP(rec.value);
            ips.push(ip);
        });

        req.on('end', function _endNetList() {
            return callback(null, ips);
        });

    });
}


/*
 * Get an IP
 *
 * @param app {App}
 * @param log {Log}
 * @param params {Object}:
 * - `ip`: IP object (required)
 * - `network_uuid`: Network UUID (required)
 * - `returnObject` {Boolean}: Return an IP object even if the record
 *   does not exist in moray (optional)
 * @param callback {Function} `function (err, ipObj)`
 */
function getIP(opts, callback) {
    var app = opts.app;
    var log = opts.log;
    var params = opts.params;

    log.debug(params, 'getIP: entry');
    var ip = util_ip.toIPAddr(params.ip);
    if (!ip) {
        callback(new restify.InvalidArgumentError(
            'Invalid IP %s', params.ip));
        return;
    }

    var ipBucket = common.getBucketObj(params.network_uuid);
    var key = common.getIPKey(params.network.ip_use_strings, ip);

    mod_moray.getObj(app.moray, ipBucket, key, function (err, rec) {
        if (err) {
            if (err.statusCode === 404) {
                if (opts.returnObject) {
                    return callback(null, new IP({
                        etag: null,
                        free: true,
                        ip: ip,
                        network: params.network,
                        network_uuid: params.network_uuid,
                        reserved: false
                    }));
                }

                return callback(
                    new restify.ResourceNotFoundError('IP not found'));
            }

            return callback(err);
        }

        rec.value.network = params.network;
        rec.value.network_uuid = params.network_uuid;
        rec.value.etag = rec._etag;

        log.debug({ value: rec.value }, 'got IP');
        return callback(null, new IP(rec.value));
    });
}


/**
 * Updates an IP
 *
 * @param app {App}
 * @param log {Log}
 * @param existingIP {Object}: The IP being updated
 * @param params {Object}:
 * - `belongs_to_type`: Belongs to type (optional)
 * - `belongs_to_uuid`: Belongs to UUID (optional)
 * - `ip`: IP address (required)
 * - `network_uuid`: Network UUID (required)
 * - `owner_uuid`: Owner UUID (optional)
 * - `reserved`: Reserved (optional)
 * @param callback {Function} `function (err, ipObj)`
 */
function updateIP(opts, callback) {
    var params = opts.params;
    var log = opts.log;

    log.debug(params, 'updateIP: entry');
    var ip = util_ip.toIPAddr(params.ip);

    if (!ip) {
        callback(new restify.InvalidArgumentError(
            'Invalid IP "%s"', params.ip));
        return;
    }

    var validateParams = {
        optional: {
            belongs_to_type: validate.string,
            belongs_to_uuid: validate.UUID,
            check_owner: validate.bool,
            owner_uuid: validate.UUID,
            reserved: validate.bool,
            unassign: validate.bool,
            free: validate.bool
        },

        required: {
            network: validateNetworkObj
        },

        after: [validateNetworkOwner, validateFreeUnassign]
    };

    // both belongs_to_type and belongs_to_uuid must be set in UFDS at the
    // same time.  If they are set, owner_uuid must be as well.
    if (params.hasOwnProperty('oldIP')) {
        if (params.belongs_to_uuid && !params.oldIP.belongs_to_type) {
            validateParams.required.belongs_to_type =
                validateParams.optional.belongs_to_type;
            delete validateParams.optional.belongs_to_type;
        }

        if (params.belongs_to_type && !params.oldIP.belongs_to_uuid) {
            validateParams.required.belongs_to_uuid =
                validateParams.optional.belongs_to_uuid;
            delete validateParams.optional.belongs_to_uuid;
        }

        if (!params.oldIP.owner_uuid && (params.belongs_to_type ||
            params.belongs_to_uuid)) {
            validateParams.required.owner_uuid =
                validateParams.optional.owner_uuid;
            delete validateParams.optional.owner_uuid;
        }
    }

    validate.params(validateParams, null, params,
        function (validationErr, validatedParams) {
        if (validationErr) {
            return callback(validationErr);
        }

        var key = common.getIPKey(validatedParams.network.ip_use_strings, ip);

        var updateOpts = {
            bucket: common.getBucketObj(params.network_uuid),
            key: key,
            original: opts.existingIP.raw(),
            etag: opts.existingIP.etag,
            moray: opts.app.moray,
            val: validatedParams
        };

        // If unassigning, remove the 'belongs_to' information, but keep
        // owner and reserved
        if (validatedParams.unassign) {
            updateOpts.val = {
                belongs_to_type: true,
                belongs_to_uuid: true
            };
            updateOpts.remove = true;
        }

        // Don't add the entire network object to the moray record
        delete updateOpts.val.network;

        mod_moray.updateObj(updateOpts, function (err, rec) {
            if (err) {
                log.error({
                    err: err,
                    ip: params.ip.toString(),
                    opts: { val: updateOpts.val, remove: updateOpts.remove }
                }, 'Error updating IP');

                return callback(err);
            }

            rec.value.network = params.network;
            rec.value.network_uuid = params.network_uuid;
            var newIP = new IP(rec.value);

            log.info({
                ip: params.ip.toString(),
                obj: newIP.serialize(),
                opts: { val: updateOpts.val, remove: updateOpts.remove }
            }, 'Updated IP');

            return callback(null, newIP);
        });
    });
}


/**
 * Creates an IP
 *
 * @param opts {App}
 * - `app`: The application object
 * - `log`: The Bunyan logger
 * - `params`: The parameters for the IP:
 *   - `ip`: IP address (required)
 *   - `network_uuid`: Network UUID (required)
 *   - `network`: Network object (required)
 * @param callback {Function} `function (err, ipObj)`
 */
function createIP(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var params = opts.params;
    var log = opts.log;

    log.debug(params, 'createIP: entry');

    validate.params(CREATE_SCHEMA, null, params,
        function (validationErr, validated) {
        if (validationErr) {
            return callback(validationErr);
        }

        var ip;
        try {
            ip = new IP(validated);
        } catch (err) {
            log.error(err, 'addIP: error creating IP');
            return callback(err);
        }

        var key = ip.key();
        var ipBucket = common.getBucketObj(validated.network.uuid);
        log.debug({ params: params, bucket: ipBucket }, 'addIP: creating IP');

        opts.app.moray.putObject(ipBucket.name, key, ip.raw(),
            { etag: null }, function (err, res) {
            if (err) {
                log.error({
                    err: err,
                    ip: ip.address.toString(),
                    obj: ip.serialize()
                }, 'Error creating IP');

                callback(err);
                return;
            }

            log.info({
                ip: ip.address.toString(),
                obj: ip.serialize()
            }, 'Created IP');

            ip.etag = res.etag;

            callback(null, ip);
        });
    });
}


/**
 * Create a new IP object using the parameters from the old object, plus
 * any updated parameters
 */
function createUpdatedObject(oldIP, params) {
    var updatedIpParams = oldIP.serialize();
    NIC_SHARED_PARAMS.forEach(function (p) {
        if (params.hasOwnProperty(p)) {
            updatedIpParams[p] = params[p];
        }
    });
    updatedIpParams.etag = oldIP.etag;
    updatedIpParams.network = oldIP.params.network;

    return new IP(updatedIpParams);
}


/**
 * Creates an IP
 *
 * @param app {App}
 * @param log {Log}
 * @param params {Object}:
 * - `batch` {Array of Objects}
 * - `ip`: IP address (required)
 * - `network_uuid`: Network UUID (required)
 * @param callback {Function} `function (err, ipObj)`
 */
function batchCreateIPs(app, log, params, callback) {
    log.debug(params, 'batchCreateIPs: entry');
    var bucket = common.getBucketObj(params.network_uuid);
    var ips = [];

    var batchData = params.batch.map(function (ipParams) {
        var ip = new IP(ipParams);
        ips.push(ip);

        var key = ip.key();

        return {
            bucket: bucket.name,
            key: key,
            operation: 'put',
            value: ip.raw()
        };
    });

    log.info({ batch: batchData }, 'batchCreateIPs: creating IPs');
    app.moray.batch(batchData, function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, ips);
    });
}


/*
 * Deletes an IP
 *
 * @param opts {Object}:
 * - `app` {App}
 * - `log` {Log}
 * - `params` {Object}:
 *   - `ip`: IP number or address (required)
 *   - `network_uuid`: Network UUID (required)
 * @param callback {Function} `function (err, ipObj)`
 */
function deleteIP(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    var params = opts.params;
    var log = opts.log;

    log.debug(params, 'deleteIP: entry');

    var ip = util_ip.toIPAddr(params.ip);
    if (!ip) {
        callback(new restify.InvalidArgumentError(
            'Invalid IP "%s"', params.ip));
        return;
    }

    var use_strings = params.network.ip_use_strings;
    var bucket = common.bucketName(params.network.uuid);
    var key = common.getIPKey(use_strings, ip);
    var val = {
        reserved: false
    };

    if (use_strings) {
        val.ipaddr = ip.toString();
    } else {
        val.ip = ip.toLong();
    }

    log.info(params, 'deleteIP: deleting IP %s', ip.toString());

    opts.app.moray.putObject(bucket, key, val, {
        etag: opts.existingIP.etag
    }, function (err, res) {
        if (err) {
            callback(err);
            return;
        }

        val.etag = res.etag;
        val.network = params.network;
        val.network_uuid = params.network.uuid;

        callback(null, new IP(val));
    });
}


/**
 * Extract all parameters necessary for IP creation from params and return
 * them in a new object
 */
function extractParams(params, override) {
    if (!override) {
        override = {};
    }

    var newParams = {};
    CREATE_PARAMS.forEach(function (s) {
        if (params.hasOwnProperty(s)) {
            newParams[s] = params[s];
        }

        if (override.hasOwnProperty(s)) {
            newParams[s] = override[s];
        }
    });

    return newParams;
}


/**
 * Initializes the nic tags bucket
 */
function initIPbucket(app, networkUUID, callback) {
    var ipBucket = common.getBucketObj(networkUUID);
    mod_moray.initBucket(app.moray, ipBucket, callback);
}



module.exports = {
    batchCreate: batchCreateIPs,
    BUCKET: common.BUCKET,
    bucket: common.getBucketObj,
    bucketInit: initIPbucket,
    bucketName: common.bucketName,
    create: createIP,
    createUpdated: createUpdatedObject,
    del: deleteIP,
    get: getIP,
    key: common.getIPKey,
    IP: common.IP,
    list: listNetworkIPs,
    nextIPonNetwork: require('./provision').nextIPonNetwork,
    params: extractParams,
    update: updateIP
};
