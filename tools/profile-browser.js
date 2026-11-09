/*
 * Browser import baseline with real timings.
 *
 * Run: node tools/profile-browser.js
 *
 * Starts tools/browser-server.js plus a tiny profile receiver, then opens the
 * existing batch end-to-end page in headless Edge/Chrome *without* virtual
 * time, so performance.now() reports real CPU time. The page POSTs the
 * __deepnestImportProfile recorded by main/deepnest.js to the receiver.
 *
 * DevTools remote debugging is used by tools/run-browser-tests.ps1 alternatives
 * but is blocked by policy on some machines, hence the POST receiver.
 *
 * Needs network access to convert.deepnest.io for the DXF file in the batch.
 * Set BROWSER_TEST_EDGE to override the browser executable.
 */
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');

var REPO = path.join(__dirname, '..');
var PROFILE_TIMEOUT_MS = 180000;

function findBrowser() {
	var candidates = [
		process.env.BROWSER_TEST_EDGE,
		'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
	];
	for (var i = 0; i < candidates.length; i++) {
		if (candidates[i] && fs.existsSync(candidates[i])) {
			return candidates[i];
		}
	}
	throw new Error('Edge or Chrome was not found. Set BROWSER_TEST_EDGE.');
}

function randomPort(min, max) {
	return Math.floor(min + Math.random() * (max - min));
}

function delay(ms) {
	return new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

function killTree(pid) {
	if (!pid) {
		return;
	}
	try {
		if (process.platform === 'win32') {
			childProcess.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
				stdio: 'ignore'
			});
		}
		else {
			process.kill(pid, 'SIGKILL');
		}
	}
	catch (error) {
		// already gone
	}
}

function startReceiver() {
	var resolveProfile;
	var rejectProfile;
	var profilePromise = new Promise(function (resolve, reject) {
		resolveProfile = resolve;
		rejectProfile = reject;
	});
	var server = http.createServer(function (request, response) {
		if (request.method === 'OPTIONS') {
			response.writeHead(204, {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Headers': 'Content-Type',
				'Access-Control-Allow-Methods': 'POST'
			});
			response.end();
			return;
		}
		if (request.method !== 'POST') {
			response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
			response.end();
			return;
		}
		var chunks = [];
		request.on('data', function (chunk) {
			chunks.push(chunk);
		});
		request.on('end', function () {
			response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
			response.end();
			try {
				resolveProfile(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			}
			catch (error) {
				rejectProfile(error);
			}
		});
	});
	return new Promise(function (resolve, reject) {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', function () {
			resolve({
				server: server,
				port: server.address().port,
				profilePromise: profilePromise
			});
		});
	});
}

function waitForServer(baseUrl) {
	var started = Date.now();

	function poll() {
		return fetch(baseUrl + '/health')
			.then(function (response) {
				if (response.ok) {
					return true;
				}
				throw new Error('health ' + response.status);
			})
			.catch(function () {
				if (Date.now() - started > 20000) {
					throw new Error('browser server did not start');
				}
				return delay(200).then(poll);
			});
	}

	return poll();
}

function pad(value, width) {
	value = String(value);
	while (value.length < width) {
		value += ' ';
	}
	return value;
}

function printProfile(profile) {
	console.log('[browser import timing] ' + (profile.label || 'batch') + ': ' +
		profile.total.toFixed(1) + ' ms, ' + profile.files + ' file(s)' +
		(profile.failures ? ', ' + profile.failures + ' failed' : ''));
	if (profile.stats) {
		console.log('  workers: ' + profile.stats.workerTasks +
			' task(s), main-thread fallback: ' + profile.stats.mainThreadTasks +
			', conversions: ' + profile.stats.conversions);
	}
	console.log('  ' + pad('stage', 26) + pad('n', 5) + pad('total ms', 11) +
		pad('avg ms', 10) + pad('max ms', 10));
	profile.stages.forEach(function (stage) {
		console.log('  ' + pad(stage.name, 26) + pad(stage.count, 5) +
			pad(stage.total.toFixed(1), 11) + pad(stage.avg.toFixed(1), 10) +
			pad(stage.max.toFixed(1), 10));
	});
	if (profile.slowest.length > 0) {
		console.log('  slowest files:');
		profile.slowest.forEach(function (file) {
			console.log('    ' + pad(file.name, 34) + file.ms.toFixed(1) + ' ms' +
				(file.ok ? '' : ' (failed)'));
		});
	}
}

function main() {
	var browserPath = findBrowser();
	var httpPort = randomPort(8100, 8900);
	var baseUrl = 'http://127.0.0.1:' + httpPort;
	var profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepnest-profile-'));
	var server = null;
	var browser = null;
	var receiver = null;

	function cleanup() {
		if (browser) {
			killTree(browser.pid);
		}
		if (server) {
			killTree(server.pid);
		}
		if (receiver && receiver.server) {
			receiver.server.close();
		}
		try {
			fs.rmSync(profileDir, { recursive: true, force: true });
		}
		catch (error) {
			// ignore
		}
	}

	function withTimeout(promise, ms, message) {
		return Promise.race([
			promise,
			new Promise(function (resolve, reject) {
				var timer = setTimeout(function () {
					reject(new Error(message));
				}, ms);
				timer.unref();
			})
		]);
	}

	return startReceiver()
		.then(function (started) {
			receiver = started;
			server = childProcess.spawn(process.execPath, [
				'tools/browser-server.js',
				'--port', String(httpPort)
			], {
				cwd: REPO,
				stdio: 'ignore',
				windowsHide: true
			});
			return waitForServer(baseUrl);
		})
		.then(function () {
			var profileUrl = 'http://127.0.0.1:' + receiver.port + '/';
			browser = childProcess.spawn(browserPath, [
				'--headless=new',
				'--disable-gpu',
				'--no-sandbox',
				'--no-first-run',
				'--disable-extensions',
				'--disable-background-networking',
				'--user-data-dir=' + profileDir,
				baseUrl + '/tools/browser-e2e-batch.html?profileUrl=' +
					encodeURIComponent(profileUrl)
			], {
				stdio: 'ignore',
				windowsHide: true
			});
			return withTimeout(
				receiver.profilePromise,
				PROFILE_TIMEOUT_MS,
				'no profile received from the browser'
			);
		})
		.then(function (profile) {
			console.log('Browser import profile (real clock, ' + path.basename(browserPath) + ')');
			console.log('');
			printProfile(profile);
			cleanup();
		}, function (error) {
			cleanup();
			throw error;
		});
}

main().catch(function (error) {
	console.error('profile-browser failed: ' + error.message);
	process.exit(1);
});
