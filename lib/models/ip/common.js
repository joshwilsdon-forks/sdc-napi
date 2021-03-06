/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * ip model: common code
 */

'use strict';

var assert = require('assert-plus');
var clone = require('clone');
var constants = require('../../util/constants');
var util = require('util');
var util_ip = require('../../util/ip');



// --- Globals



var BUCKET = {
    desc: 'IP',
    // name intentionally left out here: this is per-network
    schema: {
        index: {
            belongs_to_type: { type: 'string' },
            belongs_to_uuid: { type: 'string' },
            owner_uuid: { type: 'string' },
            ip: { type: 'number', unique: true },
            ipaddr: { type: 'ip', unique: true },
            reserved: { type: 'boolean' },
            v: { type: 'number' }
        }
    },
    version: 2
};
// Object params that are not required - note that setting any of
// these (or reserved) will result in the "free" property being set to false
// in the API.
var OPTIONAL_PARAMS = [
    'belongs_to_type',
    'belongs_to_uuid',
    'owner_uuid'
];



// --- IP object



/**
 * IP object constructor
 */
function IP(params) {
    assert.object(params, 'params');
    assert.object(params.network, 'params.network');
    assert.string(params.network_uuid, 'params.network_uuid');

    this.params = params;

    if (this.params.ipaddr) {
        this.params.ip = util_ip.toIPAddr(params.ipaddr);
    } else {
        this.params.ip = util_ip.toIPAddr(params.ip);
    }

    assert.ok(this.params.ip, 'params.ip');

    if (params.hasOwnProperty('reserved') &&
        typeof (params.reserved) !== 'boolean') {
        this.params.reserved = params.reserved === 'true' ? true : false;
    }

    if (params.hasOwnProperty('etag')) {
        this.etag = params.etag;
    } else {
        this.etag = null;
    }

    this.use_strings = params.use_strings ||
        (params.network && params.network.ip_use_strings);

    Object.seal(this);
}

Object.defineProperty(IP.prototype, 'address', {
    get: function () { return this.params.ip; }
});

Object.defineProperty(IP.prototype, 'reserved', {
    set: function (r) { this.params.reserved = r; }
});

Object.defineProperty(IP.prototype, 'type', {
    get: function () { return this.params.ip.kind(); }
});

Object.defineProperty(IP.prototype, 'v6address', {
    get: function () {
        return this.params.ip.toString({ format: 'v6' });
    }
});


/**
 * Returns an object suitable for passing to a moray batch
 */
IP.prototype.batch = function ipBatch() {
    var batchObj = {
        bucket: bucketName(this.params.network_uuid),
        key: this.key(),
        operation: 'put',
        value: this.raw(),
        options: {
            etag: this.etag
        }
    };

    return batchObj;
};


/**
 * Returns an object suitable for passing to a Moray batch to unassign this
 * IP from its owning NIC.
 */
IP.prototype.unassignBatch = function unassignIP() {
    var batchObj = this.batch();
    var value = batchObj.value;

    /*
     * Reserved addresses keep their owners when unassigned, so only
     * remove the owner_uuid when this is a normal, unreserved IP.
     */
    if (!this.params.reserved) {
        delete value.owner_uuid;
    }

    delete value.belongs_to_type;
    delete value.belongs_to_uuid;

    return batchObj;
};


/**
 * Get the key for this IP address in its network's bucket
 */
IP.prototype.key = function ipKey() {
    return getIPKey(this.use_strings, this.address);
};


/**
 * Returns true if this IP can be provisioned
 */
IP.prototype.provisionable = function ipProvisionable() {
    if (!this.params.belongs_to_uuid || !this.params.belongs_to_type) {
        return true;
    }

    // Allow "other" IPs to be taken - these are usually records created when
    // the network is created, like resolvers and gateway
    if (this.params.belongs_to_type === 'other' &&
        this.params.belongs_to_uuid === constants.UFDS_ADMIN_UUID) {
        return true;
    }

    return false;
};


/**
 * Check whether this address is on a fabric network.
 */
IP.prototype.isFabric = function isFabric() {
    return this.params.network.fabric;
};


/**
 * Returns the serialized form of the IP, suitable for public consumption
 */
IP.prototype.serialize = function ipSerialize() {
    var self = this;
    var ser = {
        ip: this.params.ip.toString(),
        network_uuid: this.params.network.uuid,
        reserved: this.params.reserved ? true : false,
        free: this.params.reserved ? false : true
    };

    OPTIONAL_PARAMS.forEach(function (param) {
        if (self.params.hasOwnProperty(param)) {
            ser[param] = self.params[param];
            ser.free = false;
        }
    });

    return ser;
};


/**
 * Returns the raw form suitable for storing in moray
 */
IP.prototype.raw = function ipRaw() {
    var self = this;

    var raw = {
        reserved: this.params.reserved ? true : false,
        use_strings: this.use_strings
    };

    if (this.use_strings) {
        raw.ipaddr = this.params.ip.toString();
        raw.v = BUCKET.version;
    } else {
        raw.ip = this.params.ip.toLong();
    }

    OPTIONAL_PARAMS.forEach(function (param) {
        if (self.params.hasOwnProperty(param)) {
            raw[param] = self.params[param];
        }
    });

    return raw;
};


/**
 * Returns true if this IP is the gateway of a fabric network.
 */
IP.prototype.isFabricGateway = function isFabricGateway() {
    var network = this.params.network;
    if (!network.fabric || !network.params.gateway) {
        return false;
    }

    return this.params.ip.compare(network.params.gateway) === 0;
};


// --- Exports

/**
 * Given an address, get the appropriate Moray key to search
 * for in an IP bucket.
 */
function getIPKey(use_strings, ipaddr) {
    if (!use_strings) {
        return ipaddr.toLong().toString();
    } else {
        return ipaddr.toString();
    }
}


/**
 * Returns the bucket name for a network
 */
function bucketName(networkUUID) {
    return util.format('napi_ips_%s',
        networkUUID.replace(/-/g, '_'));
}


/**
 * Returns the bucket for a network
 */
function getBucketObj(networkUUID) {
    var newBucket = clone(BUCKET);
    newBucket.name = bucketName(networkUUID);
    return newBucket;
}



module.exports = {
    BUCKET: BUCKET,
    bucketName: bucketName,
    getBucketObj: getBucketObj,
    getIPKey: getIPKey,
    IP: IP
};
