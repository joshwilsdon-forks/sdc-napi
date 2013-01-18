/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * Integration tests for /networks/:uuid/ips endpoints
 */

var helpers = require('./helpers');
var test = require('tap').test;
var util = require('util');
var vasync = require('vasync');



// --- Globals



var napi = helpers.createNAPIclient();
var state = {};
var uuids = {
  admin: '00000000-0000-0000-0000-000000000000',
  a: '564d69b1-a178-07fe-b36f-dfe5fa3602e2'
};



// --- Setup



exports['Create UFDS client'] = function (t) {
  helpers.createUFDSclient(t, state, function (err) {
    return t.done();
  });
};


exports['create test nic tag'] = function (t) {
  helpers.createNicTag(t, napi, state);
};


exports['create test network'] = function (t) {
  helpers.createNetwork(t, napi, state);
};



// --- Tests



exports['GET /networks/:uuid/ips/:ip (free IP)'] = function (t) {
  napi.getIP(state.network.uuid, '10.99.99.57', function (err, res) {
    t.ifError(err, 'getting IP: 10.99.99.57');
    var exp = {
      ip: '10.99.99.57',
      reserved: false,
      free: true
    };
    t.deepEqual(res, exp, 'GET on a free IP');

    return t.done();
  });
};


exports['PUT /networks/:uuid/ips/:ip'] = function (t) {
  var params = {
    reserved: true,
    owner_uuid: uuids.admin,
    belongs_to_type: 'zone',
    belongs_to_uuid: uuids.a
  };

  napi.updateIP(state.network.uuid, '10.99.99.59', params, function (err, res) {
    if (err) {
      return helpers.doneWithError(err, 'updating IP: 10.99.99.59');
    }

    params.ip = '10.99.99.59';
    params.free = false;
    state.ip = params;
    t.deepEqual(res, params, 'reserving an IP');

    return napi.getIP(state.network.uuid, params.ip, function (err2, res2) {
      if (err2) {
        return t.done();
      }

      t.deepEqual(res2, params, 'GET on a reserved IP');

      return t.done();
    });
  });
};


exports['GET /networks/:uuid/ips'] = function (t) {
  napi.listIPs(state.network.uuid, function (err, res) {
    if (err) {
      return helpers.doneWithError(err, 'listing IPs');
    }

    t.deepEqual(res, [ state.ip ], 'IP list');
    return t.done();
  });
};


exports['PUT /networks/:uuid/ips/:ip (free an IP)'] = function (t) {
  var doUpdate = function (_, cb) {
    var params = {
      free: true
    };

    napi.updateIP(state.network.uuid, '10.99.99.59', params,
      function (err, res) {
      if (err) {
        return helpers.doneWithError(t, err, 'freeing IP: 10.99.99.59');
      }

      params.ip = '10.99.99.59';
      params.free = true;
      params.reserved = false;
      t.deepEqual(res, params, 'freeing an IP');

      return napi.getIP(state.network.uuid, params.ip, function (err2, res2) {
        t.ifError(err2, 'getting free IP: 10.99.99.59');
        if (err2) {
          return cb(err2);
        }

        t.deepEqual(res2, params, 'GET on a free IP');
        return cb();
      });
    });
  };

  // Try this twice, to prove that it works for both a free and a non-free IP
  vasync.pipeline({
    funcs: [
      doUpdate,
      doUpdate
    ]
  }, function (err) {
    return t.done();
  });
};


exports['UFDS validation'] = function (t) {
  /* jsl:ignore (for regex warning) */
  var invalid = [
    [ { belongstouuid: 'foo' }, 'IP belongs_to_uuid' ],
    [ { owneruuid: 'foo' }, 'IP owner_uuid' ],
    [ { reserved: 'foo' }, 'IP reserved value must be true or false' ],

    [ { ip: 'foo' }, 'IP number' ],
    [ { ip: -1 }, 'IP number' ],
    [ { ip: 4294967296 }, 'IP number' ]
  ];
  /* jsl:end */

  var ufdsAdd = function (toTest, cb) {
    var desc = util.format(' (%j)', toTest[0]);
    var params = {
      ip: 174285608,
      objectclass: 'ip'
    };
    var dn = util.format('ip=174285608, uuid=%s, ou=networks',
      state.network.uuid);
    for (var p in toTest[0]) {
      params[p] = toTest[0][p];
    }

    helpers.ufdsAdd(state, dn, params, function (err) {
      t.ok(err, 'Error should be returned' + desc);
      if (err) {
        helpers.similar(t, err.message, toTest[1],
          'Error message matches' + desc);
      }

      return cb(null);
    });
  };

  vasync.forEachParallel({
    func: ufdsAdd,
    inputs: invalid
  }, function (err) {
    return t.done();
  });
};



// --- Teardown



exports['Tear down UFDS client'] = function (t) {
  helpers.destroyUFDSclient(t, state);
};


exports['remove test network'] = function (t) {
  helpers.deleteNetwork(t, napi, state);
};


exports['remove test nic tag'] = function (t) {
  helpers.deleteNicTag(t, napi, state);
};
