/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * nic model: common code
 */

'use strict';

var assert = require('assert-plus');
var constants = require('../../util/constants');
var errors = require('../../util/errors');
var mod_ip = require('../ip');
var mod_net = require('../network');
var mod_nicTag = require('../nic-tag');
var mod_pool = require('../network-pool');
var mod_portolan_moray = require('portolan-moray');
var util = require('util');
var util_common = require('../../util/common.js');
var util_intersect = require('../../util/intersect');
var validate = require('../../util/validate');


// --- Globals

var BUCKET = require('./bucket').BUCKET;
var BELONGS_TO_TYPES = [ 'other', 'server', 'zone' ];
var VALID_NIC_STATES = [ 'provisioning', 'stopped', 'running' ];

var getPoolIntersections = util_intersect.getPoolIntersections;

// --- Internal helpers

/**
 * When we send a batch request to Moray, it executes the requested operations
 * in the specified order. Since our transactions acquire row-level locks for
 * each row that we touch, we need to make sure that they are always acquired
 * in the same order, so that we don't end up with a lock order violation. If
 * this happens, Postgres will send back the error "deadlock detected".
 *
 * It's alright for us to change the initial order that the requests were
 * placed in the batch since none should share the same bucket/key pair; NAPI
 * just needs to manipulate multiple objects in the same transaction.
 *
 * Note that we sort on the "bucket" in _descending_ alphabetical order. This
 * is intentional, so that we get the following order when deleting a NIC in
 * NAPI:
 *
 *   - napi_nics
 *   - napi_networks (when deleting a fabric gateway NIC)
 *   - napi_ips_*
 *
 * This ensures that we'll try to delete the NIC object before we try updating
 * the network and IP objects, so that when we have racing DELETE requests we
 * get an ObjectNotFoundError back from Moray, instead of an EtagConflictError.
 *
 * Requests in the batch that operate on the portolan_* buckets are kept in
 * their original order in commitBatch() below. This is to preserve the order
 * of the Portolan events we generate.
 */
function compareRequests(a, b) {
    if (a.bucket < b.bucket) {
        return 1;
    } else if (a.bucket > b.bucket) {
        return -1;
    } else if (a.key < b.key) {
        return -1;
    } else if (a.key > b.key) {
        return 1;
    } else {
        return 0;
    }
}

/**
 * If an owner_uuid has been specified, and we haven't been explicitly
 * told to ignore it, then make sure it's okay to provision on this
 * network.
 */
function badOwnerUUID(parsedParams, network) {
    var check_owner = !parsedParams.hasOwnProperty('check_owner') ||
        parsedParams.check_owner;
    if (parsedParams.hasOwnProperty('owner_uuid') && check_owner &&
        !network.isOwner(parsedParams.owner_uuid)) {
        return true;
    }

    return false;
}


/**
 * Check that a network's NIC tag, VLAN ID, and owner match what's present on
 * the NIC. If the VNET ID needs checking, check that, too.
 */
function checkNetwork(parsedParams, name, network) {
    assert.object(parsedParams, 'parsedParams');
    assert.string(name, 'name');
    assert.object(network, 'network');

    if (badOwnerUUID(parsedParams, network)) {
        return errors.invalidParam('owner_uuid', constants.OWNER_MATCH_MSG);
    }

    if (parsedParams.nic_tag === undefined) {
        assert.string(network.nic_tag, 'networks should have a nic_tag');
        parsedParams.nic_tag = network.nic_tag;
    } else if (parsedParams.nic_tag !== network.nic_tag) {
        return errors.invalidParam(name,
            util.format(constants.fmt.NIC_TAGS_DIFFER,
            parsedParams.nic_tag, network.nic_tag));
    }

    if (parsedParams.vlan_id === undefined) {
        assert.number(network.params.vlan_id, 'networks should have a vlan_id');
        parsedParams.vlan_id = network.params.vlan_id;
    } else if (parsedParams.vlan_id !== network.params.vlan_id) {
        return errors.invalidParam(name,
            util.format(constants.fmt.VLAN_IDS_DIFFER,
            parsedParams.vlan_id, network.params.vlan_id));
    }

    return null;
}


/**
 * Validates a network UUID and ensures that the network exists
 */
function validateNetworkPool(app, log, name, uuid, callback) {
    mod_pool.get(app, log, { uuid: uuid }, function (err2, res) {
        if (err2) {
            if (err2.name === 'ResourceNotFoundError') {
                return callback(errors.invalidParam(name,
                    'network does not exist'));
            }

            return callback(err2);
        }

        var toReturn = {
            network_pool: res
        };
        toReturn[name] = res.uuid;

        callback(null, null, toReturn);
    });
}


/**
 * Validates a network UUID
 */
function validateNetworkUUID(name, uuid, callback) {
    if (uuid === 'admin') {
        return callback(null, uuid);
    }

    return validate.UUID(null, name, uuid, callback);
}


/**
 * Validate that the subnet contains the IP address
 */
function validateSubnetContainsIP(opts, name, network, ip, callback) {
    assert.object(opts, 'opts');
    assert.string(name, 'name');
    assert.object(network, 'network');
    assert.object(ip, 'ip');
    assert.func(callback, 'callback');

    if (!network.subnet.contains(ip)) {
        callback(errors.invalidParam(name, util.format(
            constants.fmt.IP_OUTSIDE, ip.toString(), network.uuid)));
        return;
    }

    var getOpts = {
        app: opts.app,
        log: opts.log,
        params: {
            ip: ip,
            network: network,
            network_uuid: network.uuid
        },
        // If it's missing in moray, return an object anyway:
        returnObject: true
    };
    mod_ip.get(getOpts, function checkIP(err, res) {
        if (err) {
            // XXX : return different error here
            callback(err);
            return;
        }

        // Don't allow taking another NIC's IP on create if it's taken by
        // something else (server, zone)
        if (opts.create && !res.provisionable()) {
            callback(errors.usedByParam(name,
                res.params.belongs_to_type,
                res.params.belongs_to_uuid,
                util.format(constants.fmt.IP_IN_USE,
                    res.params.belongs_to_type,
                    res.params.belongs_to_uuid)));
            return;
        }

        callback(null, res);
    });
}



// --- Exported functions



/**
 * Validate a NIC tag that may potentially be an overlay tag (of the form
 * sdc_overlay_tag/1234).
 */
function validateNicTag(opts, name, tag, callback) {
    validate.string(null, name, tag, function (strErr) {
        if (strErr) {
            callback(strErr);
            return;
        }

        var split = tag.split('/');
        if (split.length > 2) {
            callback(errors.invalidParam(name, constants.msg.NIC_TAG_SLASH));
            return;
        }

        var tagName = split[0];

        mod_nicTag.validateExists(true, opts, name, tagName, function (exErr) {
            if (exErr) {
                callback(exErr);
                return;
            }

            if (split[1] === undefined) {
                callback(null, tagName);
                return;
            }

            validate.VxLAN(null, name, split[1], function (vErr, vid) {
                if (vErr) {
                    callback(vErr);
                    return;
                }

                var toReturn = {};
                toReturn[name] = tagName;
                toReturn.vnet_id = vid;

                callback(null, null, toReturn);
            });
        });
    });
}


/**
 * Validates a network UUID and ensures that the network exists
 */
function validateNetwork(opts, name, uuid, callback) {
    var app = opts.app;
    var log = opts.log;
    validateNetworkUUID(name, uuid, function (err) {
        if (err) {
            callback(err);
            return;
        }

        mod_net.get({ app: app, log: log, params: { uuid: uuid } },
                function (err2, res) {
            if (err2) {
                if (err2.name === 'ResourceNotFoundError') {
                    validateNetworkPool(app, log, name, uuid, callback);
                    return;
                }

                callback(err2);
                return;
            }

            var toReturn = {
                network: res
            };
            toReturn[name] = res.uuid;

            callback(null, null, toReturn);
        });
    });
}


/**
 * Validate that a parameter is an IPv4 network or pool.
 */
function validateIPv4Network(opts, name, uuid, callback) {
    validateNetwork(opts, name, uuid, function (err, _, toReturn) {
        if (err) {
            callback(err);
            return;
        }

        var net = toReturn.network || toReturn.network_pool;
        if (net.family !== 'ipv4') {
            callback(errors.invalidParam(name, util.format(
                constants.fmt.NET_BAD_AF, 'IPv4')));
            return;
        }

        callback(null, null, toReturn);
    });
}


/**
 * Validate that the network parameters are valid
 */
function validateNetworkParams(opts, _, parsedParams, callback) {
    var cErr;

    // Not allowed to provision an IP on a network pool
    if (parsedParams.ip && parsedParams.network_pool) {
        callback(errors.invalidParam('ip', constants.POOL_IP_MSG));
        return;
    }

    if (parsedParams.network) {
        cErr = checkNetwork(parsedParams, 'network_uuid', parsedParams.network);
        if (cErr !== null) {
            callback(cErr);
            return;
        }
    }

    if (parsedParams.network_pool) {
        if (badOwnerUUID(parsedParams, parsedParams.network_pool)) {
            callback(errors.invalidParam('owner_uuid',
                constants.OWNER_MATCH_MSG));
            return;
        }

        try {
            parsedParams.intersections = getPoolIntersections('network_uuid',
                parsedParams, [ parsedParams.network_pool ]);
        } catch (e) {
            callback(e);
            return;
        }
    }

    if (!parsedParams.ip) {
        callback();
        return;
    }

    function saveIP(err, _ip) {
        parsedParams._ip = _ip;
        callback(err);
    }

    // network_uuid and ip were specified, so just validate
    if (parsedParams.ip && parsedParams.network) {
        validateSubnetContainsIP(opts, 'ip',
            parsedParams.network, parsedParams.ip, saveIP);
        return;
    }

    // IP specified, but no network UUID: vlan_id and nic_tag are needed to
    // figure out what network the NIC is on.
    var errs = [];
    ['nic_tag', 'vlan_id'].forEach(function (p) {
        if (!parsedParams.hasOwnProperty(p)) {
            errs.push(errors.missingParam(p, constants.msg.IP_NO_VLAN_TAG));
        }
    });

    if (errs.length !== 0) {
        callback(errs);
        return;
    }

    lookupUnknownIP(opts, parsedParams, 'ip', parsedParams.ip, saveIP);
}


function lookupUnknownIP(opts, parsedParams, name, unknownIP, callback) {
    assert.object(opts, 'opts');
    assert.object(parsedParams, 'parsedParams');
    assert.number(parsedParams.vlan_id, 'parsedParams.vlan_id');
    assert.string(parsedParams.nic_tag, 'parsedParams.nic_tag');
    assert.optionalNumber(parsedParams.vnet_id, 'parsedParams.vnet_id');
    assert.string(name, 'name');
    assert.func(callback, 'callback');

    var vlan_id = parsedParams.vlan_id;
    var vnet_id = parsedParams.vnet_id;
    var nic_tag = parsedParams.nic_tag;

    mod_net.findContaining(opts, vlan_id, nic_tag, vnet_id, unknownIP,
        function lookupNetwork(err, uuids) {
        if (err) {
            callback(err);
            return;
        }

        if (uuids.length === 0) {
            callback(errors.invalidParam(name,
                util.format(constants.fmt.IP_NONET, nic_tag, vlan_id,
                unknownIP)));
            return;
        }

        if (uuids.length > 1) {
            callback(errors.invalidParam(name,
                util.format(constants.fmt.IP_MULTI, uuids.sort().join(', '),
                unknownIP)));
            return;
        }

        opts.network_cache.get(uuids[0], function (netGetErr, network) {
            if (netGetErr) {
                callback(netGetErr);
                return;
            }

            var netCheckErr = checkNetwork(parsedParams, name, network);
            if (netCheckErr !== null) {
                callback(netCheckErr);
                return;
            }

            validateSubnetContainsIP(opts, name, network, unknownIP, callback);
        });
    });
}

/*
 * Determine if NIC is provisioned on top of fabric. If so, make sure that NIC
 * has cn_uuid set. If not, it's all good.
 */
function validateFabricNic(_opts, _params, parsedParams, callback) {
    var fabric = false;
    if (parsedParams.network) {
        fabric = parsedParams.network.fabric;
    }
    if (fabric && parsedParams.cn_uuid === undefined) {
        callback(errors.missingParam('cn_uuid'));
    } else {
        callback(null);
    }
}

/*
 * The NIC's boolean property `underlay` can only be set to true if the
 * `belongs_to_type` is to set to 'server'.
 */
function validateUnderlayServer(opts, params, _parsedParams, callback) {
    var belongs_to_type = undefined;
    if (params.belongs_to_type !== undefined) {
        belongs_to_type = params.belongs_to_type;
    } else {
        belongs_to_type = opts.existingNic.params.belongs_to_type;
    }
    if (params.underlay && belongs_to_type !== 'server') {
        callback(errors.invalidParam('underlay',
            constants.SERVER_UNDERLAY_MSG));
    } else {
        callback(null);
    }
}

// --- Common create/updates/delete pipeline functions

/**
 * Provided with a vnet_id, appends the list of vnet cns to opts.vnetCns.
 */
function listVnetCns(opts, callback) {
    assert.object(opts, 'opts');
    assert.number(opts.vnet_id, 'opts.vnet_id');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.log, 'opts.log');

    opts.log.debug({ vnet_id: opts.vnet_id }, 'listVnetCns: enter');

    mod_portolan_moray.vl2LookupCns(opts, function (listErr, cns) {
        if (listErr) {
            opts.log.error({ err: listErr, vnet_id: opts.vnet_id },
                'listVnetCns: error fetching cn list on vnet');
            return callback(listErr);
        }

        var vnetCns = Object.keys(cns.reduce(function (acc, cn) {
            acc[cn.cn_uuid] = true;
            return acc;
        }, {}));

        opts.log.debug({ vnetCns: vnetCns }, 'listVnetCns: exit');

        return callback(null, vnetCns);
    });
}

/**
 * Commits opts.batch to moray
 */
function commitBatch(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app.moray, 'opts.app.moray');
    assert.object(opts.log, 'opts.log');
    assert.arrayOfObject(opts.batch, 'opts.batch');

    /*
     * Split out the Portolan updates so that we preserve their
     * current order.
     */
    var nbatch = [];
    var pbatch = [];

    opts.batch.forEach(function (r) {
        if (r.bucket.indexOf('portolan') === -1) {
            nbatch.push(r);
        } else {
            pbatch.push(r);
        }
    });

    nbatch.sort(compareRequests);

    var batch = nbatch.concat(pbatch);

    opts.log.info({ batch: batch }, 'commitBatch: enter');

    opts.app.moray.batch(batch, function (err, res) {
        if (err) {
            opts.log.error(err, 'commitBatch error');
            callback(err);
            return;
        }

        if (opts.nic) {
            opts.nic.etag =
                util_common.getEtag(res.etags,
                    BUCKET.name, opts.nic.mac.toLong().toString());
        }

        callback();
    });
}



module.exports = {
    BELONGS_TO_TYPES: BELONGS_TO_TYPES,
    VALID_NIC_STATES: VALID_NIC_STATES,
    BUCKET: BUCKET,
    commitBatch: commitBatch,
    listVnetCns: listVnetCns,
    validateIPv4Network: validateIPv4Network,
    validateNicTag: validateNicTag,
    validateNetwork: validateNetwork,
    validateNetworkParams: validateNetworkParams,
    validateFabricNic: validateFabricNic,
    validateUnderlayServer: validateUnderlayServer
};
