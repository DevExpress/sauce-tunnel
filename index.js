/* npm */
const chalk = require('chalk');
const split = require('split');
const axios = require('axios');

/* core */
const util = require('util');
const os   = require('os');
const path = require('path');
const proc = require('child_process');

const EventEmitter = require('events').EventEmitter;

const binaries = {
  'darwin': 'sc',
  'linux': 'sc',
  'linux32': 'sc',
  'win32': 'sc.exe'
};


async function request ({ method, url, auth }, callback) {
    try {
      const res = await axios({
        method,
        url,
        responseType: 'json',
        auth,
      })

      callback(null, res);
    } catch (e) {
      callback(e);
    }
}

module.exports = SauceTunnel;

function SauceTunnel(user, key, identifier, tunneled, extraFlags) {
  EventEmitter.call(this);
  this.user = user;
  this.key = key;
  this.identifier = identifier || 'Tunnel'+new Date().getTime();
  this.tunneled = (tunneled == null) ? true : tunneled;
  this.region = 'us-west-1';
  this.baseUrl = `https://api.${this.region}.saucelabs.com/rest/v1/${this.user}`;
  
  this.extraFlags = extraFlags;
  this.id = null;
}

util.inherits(SauceTunnel, EventEmitter);

SauceTunnel.prototype.openTunnel = function(callback) {
  // win32, darwin or linux
  let platform = os.platform();

  // Special case: 32bit linux?
  platform += (platform === 'linux' && os.arch() === 'ia32') ? '32' : '';

  const executable = binaries[platform];
  if (!executable) {
    throw new Error(platform + ' platform is not supported');
  }
  let args = ['run'];

  if (this.identifier) {
    args.push("--tunnel-name", this.identifier);
  }
  args.push('--region', this.region);
  if (this.extraFlags) {
    args = args.concat(this.extraFlags);
  }
  const cmd = path.join(__dirname, 'vendor', platform, 'bin/', executable);

  this.proc = proc.spawn(cmd, args, {
    env: {
      SAUCE_USERNAME: this.user,
      SAUCE_ACCESS_KEY: this.key,
    }
  });
  callback.called = false;

  this.proc.stdout.pipe(split()).on('data', (data) => {
    if (!data.match(/^\[-u,/g)) {
      this.emit('verbose:debug', data);
    }
    if (data.match(/Sauce Connect is up, you may start your tests/)) {
      this.emit('verbose:ok', '=> Sauce Labs Tunnel established');
      if (!callback.called) {
        callback.called = true;
        callback(true);
      }
    }
    const match = data.match(/id=([a-f0-9]{32})/i);
    if (match) {
      this.id = match[1];
    }
  });

  this.proc.stderr.pipe(split()).on('data', (data) => {
    this.emit('log:error', data);
  });

  this.proc.on('exit', (code) => {
    this.emit('verbose:ok', 'Sauce Labs Tunnel disconnected ', code);
    if (!callback.called) {
      callback.called = true;
      callback(false);
    }
  });
};

SauceTunnel.prototype.getTunnels = function(callback) {
  request({
    method: 'GET',
    url: this.baseUrl + '/tunnels',
    auth: {
      username: this.user,
      password: this.key,
    }
  }, (err, resp) => {
    if (err || !resp) {
      callback(err || new Error('No response'));
      return;
    }
    callback(resp.data);
  });
};

SauceTunnel.prototype.killTunnel = function(callback) {
  if (!this.tunneled) {
    return callback();
  }

  this.emit('verbose:debug', 'Trying to kill tunnel');
  request({
    method: "DELETE",
    url: this.baseUrl + "/tunnels/" + this.id,
    auth: {
      username: this.user,
      password: this.key,
    }
  }, (err, resp) => {
    if (!err && resp && resp.status === 200) {
      this.emit('verbose:debug', 'Tunnel Closed');
    }
    else {
      this.emit('log:error', 'Error closing tunnel');
    }
    callback(err);
  });
};

SauceTunnel.prototype.start = function(callback) {
  if (!this.tunneled) {
    return callback(true);
  }
  this.emit('verbose:writeln', chalk.inverse("=> Sauce Labs trying to open tunnel"));
  this.openTunnel(function(status) {
    callback(status);
  });
};

SauceTunnel.prototype.stop = function (callback) {
  let callbackArg;

  this.proc.on('exit', function () {
    callback(callbackArg);
  });

  this.killTunnel((err) => {
    // When deleting the tunnel via the REST API succeeds, then Sauce Connect exits automatically.
    // Otherwise kill the process. Don't care with the tunnel, it will time out.
    if (err) {
      callbackArg = err;
      this.proc.kill();
    }
  });
};

SauceTunnel.prototype.kill = function(callback) {
    if (this.proc) {
      this.proc.on('exit', function () {
        callback();
      });
      this.proc.kill();
    }
    else {
      callback();
    }
};
