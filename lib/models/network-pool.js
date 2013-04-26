/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * network pool model
 */

var assert = require('assert');
var constants = require('../util/constants');
var errors = require('../util/errors');
var mod_moray = require('../apis/moray');
var mod_net = require('./network');
var restify = require('restify');
var util = require('util');
var util_common = require('../util/common');
var UUID = require('node-uuid');
var validate = require('../util/validate');
var vasync = require('vasync');



// --- Globals



var BUCKET = {
    desc: 'network pool',
    name: 'napi_network_pools',
    schema: {
        index: {
            uuid: { type: 'string', unique: true }
        }
    }
};
var MAX_NETS = 64;



// --- Helpers



/**
 * Validate that the networks in a pool are not over the maximum limit, and
 * that they all exist.
 */
function validateNetworks(app, log, name, list, callback) {
    var nets = [];
    var notFound = [];
    var tag;
    var tagsNotMatching = [];
    var uuids = util_common.arrayify(list);
    var validated = [];

    if (uuids.length > MAX_NETS) {
        return callback(errors.invalidParam(name,
            util.format('maximum %d networks per network pool', MAX_NETS)));
    }

    vasync.forEachParallel({
        inputs: uuids,
        func: function _validateNetworkUUID(uuid, cb) {
            // XXX: what to bubble up if this is an error talking to moray?
            mod_net.get(app, log, { uuid: uuid }, function (err, res) {
                if (err || !res) {
                    notFound.push(uuid);
                    return cb();
                }

                if (tag === undefined) {
                    tag = res.params.nic_tag;
                }

                if (res.params.nic_tag != tag) {
                    tagsNotMatching.push(uuid);
                    return cb();
                }

                validated.push(uuid);
                nets.push(res);
                return cb();
            });
        }
    }, function () {
        if (notFound.length !== 0) {
            var err = errors.invalidParam(name,
                util.format('unknown network%s',
                    notFound.length === 1 ? '' : 's'));
            err.invalid = notFound;
            return callback(err);
        }

        if (tagsNotMatching.length !== 0) {
            return callback(errors.invalidParam(name,
                constants.POOL_TAGS_MATCH_MSG));
        }

        var toReturn = { _networks: nets };
        toReturn[name] = validated;

        return callback(null, toReturn);
    });
}


/**
 * Validate that if a pool has an owner_uuid, all networks in the pool either
 * match that owner_uuid or have no owner_uuid.
 */
function validateNetworkOwners(original, parsed, callback) {
    if (!parsed.owner_uuid || !parsed._networks ||
        parsed._networks.length === 0) {
        return callback();
    }

    var notMatching = [];
    parsed._networks.forEach(function (net) {
        if (net.params.hasOwnProperty('owner_uuid') &&
            (net.params.owner_uuid !== parsed.owner_uuid) &&
            (net.params.owner_uuid !== constants.UFDS_ADMIN_UUID)) {
            notMatching.push(net.uuid);
        }
    });

    if (notMatching.length !== 0) {
        var err = errors.invalidParam('networks',
            constants.POOL_OWNER_MATCH_MSG);
        err.invalid = notMatching;
        return callback(err);
    }

    return callback();
}



// --- NetworkPool object



/**
 * Network pool model constructor
 */
function NetworkPool(params) {
    delete params.nic_tag;
    if (params._networks && util.isArray(params._networks) &&
        params._networks.length !== 0) {
        params.nic_tag = params._networks[0].params.nic_tag;
        delete params._networks;
    }
    this.params = params;

    if (!this.params.uuid) {
        this.params.uuid = UUID.v4();
    }

    if (this.params.hasOwnProperty('networks')) {
        this.params.networks = util_common.arrayify(this.params.networks);
    }

    this.__defineGetter__('networks', function () {
        return this.params.networks.sort();
    });
    this.__defineGetter__('uuid', function () { return this.params.uuid; });
}


/**
 * Returns the raw moray form of the network pool
 */
NetworkPool.prototype.raw = function poolRaw() {
    var ser = {
        uuid: this.params.uuid,
        name: this.params.name,
        networks: this.params.networks.sort()
    };

    if (this.params.hasOwnProperty('owner_uuid')) {
        ser.owner_uuid = this.params.owner_uuid;
    }

    return ser;
};


/**
 * Returns the serialized (API-facing) form of the network pool
 */
NetworkPool.prototype.serialize = function poolSerialize() {
    var ser = this.raw();
    if (this.params.hasOwnProperty('nic_tag')) {
        ser.nic_tag = this.params.nic_tag;
    }

    return ser;
};



// --- Exported functions



/**
 * Creates a new network pool
 */
function createNetworkPool(app, log, params, callback) {
    log.debug(params, 'createNetworkPool: entry');

    validate.params({
        params: params,

        required: {
            name: validate.string,
            networks: function (name, list, cb) {
                return validateNetworks(app, log, name, list, cb);
            }
        },

        optional: {
            owner_uuid: validate.UUID,
            uuid: validate.UUID
        },

        after: validateNetworkOwners

    }, function (err, validatedParams) {
        if (err) {
            return callback(err);
        }

        var pool = new NetworkPool(validatedParams);
        app.moray.putObject(BUCKET.name, pool.uuid, pool.raw(),
            function (err2) {
            if (err2) {
                return callback(err2);
            }

            return callback(null, pool);
        });
    });
}


/**
 * Gets a network pool
 */
function getNetworkPool(app, log, params, callback) {
    log.debug(params, 'getNetworkPool: entry');

    validate.params({
        params: params,
        required: {
            uuid: validate.UUID
        }
    }, function (err) {
        if (err) {
            return callback(err);
        }

        mod_moray.getObj(app.moray, BUCKET, params.uuid,
            function (err2, rec) {
            if (err2) {
                return callback(err2);
            }

            var netUUIDs = rec.value.networks;

            // No networks - don't bother fetching one of them, then
            if (!netUUIDs) {
                return callback(null, new NetworkPool(rec.value));
            }

            netUUIDs = util_common.arrayify(netUUIDs);
            if (netUUIDs.length === 0) {
                return callback(null, new NetworkPool(rec.value));
            }

            mod_net.get(app, log, { uuid: netUUIDs[0] },
                function (err3, res) {
                if (err3) {
                    return callback(err3);
                }

                rec.value._networks = [ res ];
                return callback(null, new NetworkPool(rec.value));
            });
        });
    });
}


/**
 * Lists network pools
 */
function listNetworkPools(app, log, params, callback) {
    log.debug(params, 'listNetworkPools: entry');
    var req = app.moray.findObjects(BUCKET.name, '(uuid=*)', {
        sort: {
            attribute: 'uuid',
            order: 'ASC'
        }
    });

    var pools = [];
    var values = [];

    req.on('error', function _onListErr(err) {
        return callback(err);
    });

    req.on('record', function _onListRec(rec) {
        log.debug(rec, 'record from moray');
        values.push(rec.value);
    });

    req.on('end', function _endList() {
        vasync.forEachParallel({
            inputs: values,
            func: function _getNet(val, cb) {
                if (!val.networks) {
                    pools.push(new NetworkPool(val));
                    return cb();
                }

                var nets = util_common.arrayify(val.networks);
                if (nets.length === 0) {
                    pools.push(new NetworkPool(val));
                    return cb();
                }

                mod_net.get(app, log, { uuid: nets[0] }, function (err, res) {
                    if (err) {
                        return cb(err);
                    }

                    val._networks = [ res ];
                    pools.push(new NetworkPool(val));

                    return cb();
                });
            }
        }, function (err) {
            if (err) {
                return callback(err);
            }

            return callback(null, pools);
        });
    });
}


/**
 * Updates a network pool
 */
function updateNetworkPool(app, log, params, callback) {
    log.debug(params, 'updateNetworkPool: entry');

    getNetworkPool(app, log, params, function (getErr, oldPool) {
        if (getErr) {
            return callback(getErr);
        }

        var toValidate = {
            params: params,

            required: {
                uuid: validate.UUID
            },

            optional: {
                name: validate.string,
                networks: validateNetworks.bind(null, app, log),
                owner_uuid: function (name, uuid, cb) {
                    if (!uuid) {
                        // Allow removing owner_uuid
                        return cb(null, false);
                    }

                    return validate.UUID(name, uuid, cb);
                }
            },

            after: function (original, parsed, cb) {
                if (!parsed.hasOwnProperty('owner_uuid') &&
                    oldPool.params.hasOwnProperty('owner_uuid')) {
                    parsed.owner_uuid = oldPool.params.owner_uuid;
                }

               return validateNetworkOwners(original, parsed, cb);
            }
        };

        if (!params.hasOwnProperty('networks') &&
            params.hasOwnProperty('owner_uuid') &&
            oldPool.params.hasOwnProperty('networks')) {
            // We need to fetch the networks to validate owner_uuid, so just
            // let validateNetworks() take care of it
            params.networks = oldPool.params.networks;
        }

        validate.params(toValidate, function (err, validatedParams) {
            if (err) {
                return callback(err);
            }

            var toUpdate = oldPool.raw();
            for (var p in validatedParams) {
                if (p === '_networks' || p === 'nic_tag') {
                    continue;
                }

                if (!validatedParams[p]) {
                    delete toUpdate[p];
                } else {
                    toUpdate[p] = validatedParams[p];
                }
            }

            mod_moray.updateObj({
                moray: app.moray,
                bucket: BUCKET,
                key: params.uuid,
                replace: true,
                val: toUpdate
            }, function (err2, rec) {
                if (err2) {
                    return callback(err2);
                }

                rec.value._networks = validatedParams._networks;
                return callback(null, new NetworkPool(rec.value));
            });
        });
    });
}


/**
 * Deletes a network pool
 */
function deleteNetworkPool(app, log, params, callback) {
    log.debug(params, 'deleteNetworkPool: entry');

    validate.params({
        params: params,
        required: {
            uuid: validate.UUID
        }
    }, function (err) {
        if (err) {
            return callback(err);
        }

        app.moray.delObject(BUCKET.name, params.uuid, function (err2) {
            if (err2) {
                return callback(err2);
            }

            return callback();
        });
    });
}


/**
 * Initializes the network pools bucket
 */
function initNetworkPools(app, callback) {
    mod_moray.initBucket(app.moray, BUCKET, callback);
}


module.exports = {
    create: createNetworkPool,
    del: deleteNetworkPool,
    get: getNetworkPool,
    init: initNetworkPools,
    list: listNetworkPools,
    NetworkPool: NetworkPool,
    update: updateNetworkPool
};