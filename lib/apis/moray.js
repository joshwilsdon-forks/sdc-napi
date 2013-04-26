/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Moray API convenience wrappers
 */

var restify = require('restify');
var util = require('util');
var util_common = require('../util/common');



// --- Exports



/**
 * Creates an LDAP filter based on the parmeters in inObj, only allowing
 * searching by indexes in bucket.schema.index
 *
 * @param inObj {Object}
 * @param bucket {Bucket schema object}
 */
function ldapFilter(inObj, bucket) {
    if (!inObj) {
        return '';
    }

    if (typeof (inObj) === 'string') {
        return inObj;
    }

    if (util_common.hashEmpty(inObj)) {
        return '';
    }

    if (inObj.hasOwnProperty('filter') && typeof (inObj.filter === 'string')) {
        return inObj.filter;
    }

    var filterBy = Object.keys(inObj).reduce(function (arr, i) {
        if (bucket && !bucket.schema.index.hasOwnProperty(i)) {
            // XXX: should error out here if trying to search by a non-indexed
            // property
            return arr;
        }

        // Comma-separated values: turn them into a list
        if (typeof (inObj[i]) === 'string' &&
            inObj[i].indexOf(',') !== -1) {
            /* JSSTYLED */
            inObj[i] = inObj[i].split(/\s*,\s*/);
        }

        if (typeof (inObj[i]) === 'object') {
            arr.push('(|');
            for (var j in inObj[i]) {
                // XXX: allow this outside of arrays?
                if (inObj[i][j].substr(0, 1) === '!') {
                    arr.push(util.format('(!(%s=%s))', i,
                        inObj[i][j].substr(1)));
                } else {
                    arr.push(util.format('(%s=%s)', i, inObj[i][j]));
                }
            }
            arr.push(')');

        } else {
            arr.push(util.format('(%s=%s)', i, inObj[i]));
        }

        return arr;
    }, []);

    if (filterBy.length > 1) {
        filterBy.unshift('(&');
        filterBy.push(')');
    }

    return filterBy.join('');
}


/**
 * Initializes a bucket in moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param callback {Function} `function (err, netObj)`
 */
function initBucket(moray, bucket, callback) {
    moray.getBucket(bucket.name, function (err) {
        if (err) {
            if (err.name === 'BucketNotFoundError') {
                moray.log.info(bucket.schema, 'initBucket: creating bucket %s',
                    bucket.name);
                return moray.createBucket(bucket.name, bucket.schema, callback);
            }

            moray.log.error(err, 'initBucket: error getting bucket %s',
                bucket.name);
            return callback(err);
        }

        moray.log.info(err, 'initBucket: bucket %s already exists',
            bucket.name);
        moray.updateBucket(bucket.name, bucket.schema, callback);
    });
}


/**
 * Deletes an object from moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param key {String}
 * @param callback {Function} `function (err, netObj)`
 */
function delObj(moray, bucket, key, callback) {
    moray.delObject(bucket.name, key, function (err) {
        if (err && err.name === 'ObjectNotFoundError') {
            return callback(new restify.ResourceNotFoundError(err,
                '%s not found', bucket.desc));
        }

        return callback(err);
    });
}


/**
 * Gets an object from moray
 *
 * @param moray {MorayClient}
 * @param bucket {Bucket schema object}
 * @param key {String}
 * @param callback {Function} `function (err, netObj)`
 */
function getObj(moray, bucket, key, callback) {
    moray.getObject(bucket.name, key, function (err, res) {
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                return callback(new restify.ResourceNotFoundError(err,
                    '%s not found', bucket.desc));
            }

            return callback(err);
        }

        return callback(null, res);
    });
}


/**
 * Lists objects in moray
 *
 * @param opts {Object}
 * - `filter` {String}
 * - `log` {Bunyan Logger}
 * - `moray` {MorayClient}
 * - `name` {String}
 * - `bucket` {Bucket schema object}
 * - `network_uuid`: Network UUID (required)
 * - `sort` {Object}
 * @param callback {Function} `function (err, netObj)`
 */
function listObjs(opts, callback) {
    var listOpts = {};
    var results = [];

    if (opts.sort) {
        listOpts.sort = opts.sort;
    }

    var filter = ldapFilter(opts.filter, opts.bucket) || opts.defaultFilter;
    opts.log.debug(opts.filter, 'LDAP filter: "%s"', filter);

    var req = opts.moray.findObjects(opts.bucket.name,
        filter, listOpts);

    req.on('error', function _onListErr(err) {
        return callback(err);
    });

    req.on('record', function _onListRec(rec) {
        opts.log.debug(rec, 'record from moray');
        results.push(opts.model ? new opts.model(rec.value) : rec);
    });

    req.on('end', function _endList() {
        return callback(null, results);
    });
}


/**
 * Updates an object in moray
 *
 * @param opts {Object}
 * - `moray` {MorayClient}
 * - `bucket` {Bucket schema object}
 * - `key` {String} : bucket key to update
 * - `remove` {Boolean} : remove all keys in val from the object (optional)
 * - `replace` {Boolean} : replace the object in moray with val (optional)
 * - `val` {Object} : keys to update in the object
 * @param callback {Function} `function (err, netObj)`
 */
function updateObj(opts, callback) {
    // XXX: should assert opts.* here
    if (opts.replace) {
        return opts.moray.putObject(opts.bucket.name, opts.key, opts.val,
            function (err2) {
            if (err2) {
                return callback(err2);
            }

            // Return an object in similar form to getObject()
            return callback(null, { value: opts.val });
        });
    }

    getObj(opts.moray, opts.bucket, opts.key, function (err, res) {
        if (err) {
            return callback(err);
        }

        for (var k in opts.val) {
            if (opts.remove) {
                delete res.value[k];
            } else {
                res.value[k] = opts.val[k];
            }
        }

        opts.moray.putObject(opts.bucket.name, opts.key, res.value,
            function (err2) {
            if (err2) {
                return callback(err2);
            }

            return callback(null, res);
        });
    });
}


module.exports = {
    delObj: delObj,
    filter: ldapFilter,
    getObj: getObj,
    initBucket: initBucket,
    listObjs: listObjs,
    updateObj: updateObj
};