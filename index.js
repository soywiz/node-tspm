///<reference path="typings/node/node.d.ts" />
///<reference path="typings/tspromise/tspromise.d.ts" />
///<reference path="typings/redis/redis.d.ts" />
var Promise = require('tspromise');
var httpProxy = require('http-proxy');
var _ = require('underscore');
var fs = require('fs');
var child_process = require('child_process');
var http = require('http');
var net = require('net');
var path = require('path');
var colors = require('colors');
var redis = require('redis');
var MapFileEntry = (function () {
    function MapFileEntry(domain, jsfile) {
        this.domain = domain;
        this.jsfile = jsfile;
    }
    MapFileEntry.prototype.toString = function () {
        return this.domain + ',' + this.jsfile;
    };
    return MapFileEntry;
})();
var MapFile = (function () {
    function MapFile() {
        this.entries = [];
    }
    MapFile.prototype.getUserHome = function () {
        //return process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
        return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
    };
    MapFile.prototype.getMapFilePath = function () {
        return this.getUserHome() + '/.node-tspm';
    };
    MapFile.prototype.ensureExists = function () {
        var path = this.getMapFilePath();
        if (!fs.existsSync(path)) {
            fs.writeFileSync(path, '', 'utf8');
        }
    };
    MapFile.prototype.load = function () {
        var _this = this;
        this.ensureExists();
        var contents = fs.readFileSync(this.getMapFilePath(), 'utf8');
        this.entries = [];
        contents.split("\n").forEach(function (line) {
            line = line.trim();
            if (line.length) {
                var parts = line.split(',');
                var domain = parts[0];
                var jsfile = parts[1];
                _this.entries.push(new MapFileEntry(domain, jsfile));
            }
        });
    };
    MapFile.prototype.save = function () {
        fs.writeFileSync(this.getMapFilePath(), this.entries.join("\n"), 'utf8');
    };
    MapFile.prototype.list = function () {
        if (!this.entries.length) {
            console.log(('file is empty')['green']);
        }
        else {
            console.log('items:');
            this.entries.forEach(function (entry) {
                console.log(String(entry)['green']);
            });
        }
    };
    MapFile.prototype.get = function (domain) {
        return this.entries.filter(function (t) { return t.domain == domain; })[0] || null;
    };
    MapFile.prototype.set = function (domain, jsfile) {
        var found = false;
        this.entries.forEach(function (entry) {
            if (entry.domain == domain) {
                entry.jsfile = jsfile;
                found = true;
            }
        });
        if (!found) {
            this.entries.push(new MapFileEntry(domain, jsfile));
        }
    };
    MapFile.prototype.remove = function (domain) {
        for (var n = 0; n < this.entries.length; n++) {
            if (this.entries[n].domain == domain) {
                this.entries.splice(n, 1);
                return;
            }
        }
    };
    return MapFile;
})();
function getAvailablePortAsync(bindAddress) {
    if (bindAddress === void 0) { bindAddress = '127.0.0.1'; }
    return new Promise(function (resolve) {
        var server2 = net.createServer();
        server2.listen(0, bindAddress, 1, function () {
            var port = server2.address().port;
            server2.close(function () {
                resolve(port);
            });
        });
    });
}
var Service = (function () {
    function Service(domain) {
        this.domain = domain;
        this.monitoring = false;
    }
    Service.prototype.setParameters = function (cmd, args, path, port) {
        if (this.cmd === cmd)
            return;
        if (this.args === args)
            return;
        if (this.path === path)
            return;
        if (this._port === port)
            return;
        this.cmd = cmd;
        this.args = args;
        this.path = path;
        this._port = port;
        this.restart();
    };
    Object.defineProperty(Service.prototype, "port", {
        get: function () {
            return this._port;
        },
        enumerable: true,
        configurable: true
    });
    Service.prototype.restart = function () {
        var _this = this;
        if (this.child)
            this.child.kill();
        if (!this.monitoring) {
            this.monitoring = true;
            this.child = child_process.spawn(this.cmd, this.args, {
                cwd: this.path,
                env: _.extend({}, process.env, { PORT: this._port })
            });
            console.log(('started ' + this.domain + ':' + this.port + ', process: ' + this.child.pid)['cyan']);
            this.child.stdout.on('data', function (m) {
                process.stdout.write(('[' + _this.domain + ']:' + m.toString('utf8'))['green']);
            });
            this.child.on('exit', function (code, signal) {
                var timems = 5000;
                console.log('exit:' + code + ',' + signal + ': restarting in ' + timems + ' milliseconds');
                setTimeout(function () {
                    _this.restart();
                }, timems);
            });
            this.child.on('error', function (err) {
                console.log(('child.error:' + err)['red']);
            });
        }
    };
    return Service;
})();
var Server = (function () {
    function Server() {
        this.serviceByDomain = {};
    }
    Server.prototype.getServiceByDomain = function (name, create) {
        if (create === void 0) { create = true; }
        if (create && !this.serviceByDomain[name])
            this.serviceByDomain[name] = new Service(name);
        return this.serviceByDomain[name];
    };
    Server.prototype.parseConfigFileContentsAsync = function (config) {
        var _this = this;
        var port = 9000;
        var promise = Promise.resolve();
        config.split('\n').forEach(function (line) {
            line = line.trim();
            if (!line.length)
                return;
            var parts = line.split(',', 2);
            var domain = parts[0];
            var scriptFile = parts[1];
            promise = promise.then(function () {
                return getAvailablePortAsync().then(function (port) {
                    console.log(domain + ':' + port + ' -> ' + scriptFile);
                    _this.getServiceByDomain(domain).setParameters('node', ['--harmony', path.basename(scriptFile)], path.dirname(scriptFile), port++);
                });
            });
        });
        return promise;
    };
    Server.prototype.parseConfigFileAsync = function (mapFile) {
        var _this = this;
        console.log('Loading... ' + mapFile);
        return Promise.nfcall(fs, 'readFile', mapFile, 'utf8').then(function (content) {
            return _this.parseConfigFileContentsAsync(content);
        });
    };
    Server.prototype.watchMapFile = function (mapFile) {
        var _this = this;
        console.log('Watching... ' + mapFile);
        fs.watchFile(mapFile, function (curr, prev) {
            _this.parseConfigFileAsync(mapFile);
        });
        this.parseConfigFileAsync(mapFile);
    };
    Server.prototype.listen = function (port) {
        var _this = this;
        var proxy = httpProxy.createProxyServer({ ws: true });
        proxy.on('error', function (err) {
            console.error(('proxy.error:' + err)['red']);
        });
        var getServiceByRequest = (function (req) {
            if (!req || !req.headers)
                return undefined;
            var host = req.headers.host;
            return _this.serviceByDomain[host];
        });
        var proxyServer = http.createServer(function (req, res) {
            try {
                var service = getServiceByRequest(req);
                if (service) {
                    proxy.web(req, res, { target: 'http://127.0.0.1:' + service.port, ws: true });
                }
                else {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.write('Invalid request for domain "' + req.headers.host + '"');
                    res.end();
                }
            }
            catch (e) {
                console.error(('proxyServer.catch:' + e)['red']);
            }
        });
        proxyServer.on('error', function (err) {
            console.error(('proxyServer.error: ' + err)['red']);
        });
        proxyServer.on('upgrade', function (req, socket, head) {
            try {
                var service = getServiceByRequest(req);
                if (service) {
                    proxy.ws(req, socket, { target: 'http://127.0.0.1:' + service.port, ws: true });
                }
                else {
                    socket.close();
                }
            }
            catch (e) {
                console.error(('proxyServer.upgrade.catch:' + e)['red']);
            }
        });
        proxyServer.listen(port, '127.0.0.1');
    };
    return Server;
})();
var EntryPoint = (function () {
    function EntryPoint() {
    }
    EntryPoint.process = function () {
        var mapFile = new MapFile();
        mapFile.load();
        var pid_file = __dirname + '/tspm_daemon.pid';
        var log_file = __dirname + '/tspm_daemon.log';
        process.on('SIGTERM', function () {
            console.log('Got SIGTERM.  Press Control-D to exit.');
            process.exit(0);
        });
        process.on('SIGINT', function () {
            console.log('Got SIGINT.  Press Control-D to exit.');
            process.exit(0);
        });
        switch (process.argv[2]) {
            case 'list':
                mapFile.list();
                //process.exit(0);
                return;
                break;
            case 'set':
                mapFile.set(process.argv[3], process.argv[4]);
                mapFile.list();
                mapFile.save();
                process.exit(0);
                break;
            case 'reload':
                var redisSubClient = redis.createClient();
                var domain = process.argv[3];
                redisSubClient.publish(['tspm_reload', domain], function () {
                    console.log('done');
                    process.exit(0);
                });
                console.log('sending reloading ' + domain);
                break;
            case 'remove':
                mapFile.remove(process.argv[3]);
                mapFile.list();
                mapFile.save();
                process.exit(0);
                break;
            case 'daemon':
                var out = fs.openSync(log_file, 'a');
                var child = child_process.spawn(process.argv[0], ['--harmony', process.argv[1], 'server'], {
                    detached: true,
                    stdio: ['ignore', out, out]
                });
                child.unref();
                fs.writeFileSync(pid_file, '' + child.pid);
                console.log(process.pid + ' -> ' + child.pid);
                return process.exit(0);
                break;
            case 'daemon_stop':
                if (fs.existsSync(pid_file)) {
                    process.kill(parseInt((fs.readFileSync(pid_file, { encoding: 'utf8' }))), 'SIGTERM');
                    fs.unlinkSync(pid_file);
                }
                return process.exit(0);
                break;
            case 'log':
                console.log('log: ' + log_file);
                var ls = child_process.spawn('tail', ['-f', log_file]);
                //var ls = child_process.spawn('type', [log_file]);
                ls.stdout.on('data', function (data) {
                    process.stdout.write(data);
                });
                ls.stderr.on('data', function (data) {
                    process.stderr.write(data);
                });
                ls.on('close', function (code) {
                    console.log('child process exited with code ' + code);
                    process.exit(code);
                });
                return;
                break;
            case 'server':
                console.log('Main process: ' + process.pid);
                var port = process.env.PORT || 80;
                var server = new Server();
                server.watchMapFile(mapFile.getMapFilePath());
                server.listen(port);
                console.log('listening at ' + port);
                var redisSubClient = redis.createClient();
                redisSubClient.on('message', function (channel, message) {
                    console.log(channel + ':' + message);
                    switch (channel) {
                        case 'tspm_reload':
                            var service = server.getServiceByDomain(message, false);
                            if (service)
                                service.restart();
                            break;
                    }
                });
                redisSubClient.subscribe('tspm_reload');
                console.log('redis listening');
                break;
            case 'help':
            default:
                console.log('tspm:');
                console.log('- tspm list');
                console.log('- tspm reload <domain>');
                console.log('- tspm set <domain> <path_to_js>');
                console.log('- tspm remove <domain>');
                console.log('- tspm server');
                console.log('- tspm daemon');
                console.log('- tspm daemon_stop');
                console.log('- tspm log');
                process.exit(-1);
                break;
        }
    };
    return EntryPoint;
})();
EntryPoint.process();
//# sourceMappingURL=index.js.map