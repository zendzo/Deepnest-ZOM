/*
 * Unit test for the import profiler in main/deepnest.js.
 *
 * Run: node tools/test-timing.js
 *
 * deepnest.js is loaded in a VM with tiny stubs for the Electron and DOM APIs
 * it touches at construction time, so the real Timing implementation is
 * exercised instead of a copy.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var performance = require('perf_hooks').performance;

var passed = 0;
function ok(name) {
	passed++;
	console.log('ok - ' + name);
}

var deepnestPath = path.join(__dirname, '..', 'main', 'deepnest.js');
var source = fs.readFileSync(deepnestPath, 'utf8');

var context = {
	console: console,
	performance: performance,
	setTimeout: setTimeout,
	clearTimeout: clearTimeout,
	setInterval: setInterval,
	clearInterval: clearInterval,
	Date: Date,
	Math: Math,
	JSON: JSON,
	require: function (name) {
		if (name === 'electron') {
			return {
				ipcRenderer: {
					on: function () {},
					send: function () {},
					sendSync: function () {}
				}
			};
		}
		return require(name);
	}
};
context.window = context;
context.self = context;
context.global = context;
context.document = {
	createElementNS: function () {
		return {};
	}
};

vm.createContext(context);
vm.runInContext(source, context, { filename: deepnestPath });

var timing = context.DeepnestTiming;
assert(timing, 'DeepnestTiming was not exposed on window');
ok('exposes DeepnestTiming');

assert.strictEqual(timing.enabled, false);
assert.strictEqual(timing.mark(), null);
assert.strictEqual(timing.measure('ignored', timing.now()), undefined);
ok('disabled by default and adds no samples');

timing.enable();
assert.strictEqual(timing.enabled, true);
ok('enable() turns measurement on');

timing.beginBatch('unit', 3);

var busyStart = timing.mark();
var acc = 0;
for (var i = 0; i < 2000000; i++) {
	acc += i;
}
var busyMs = timing.measure('cpu.busy', busyStart);
assert(typeof busyMs === 'number' && busyMs > 0, 'measure() did not return elapsed ms');
assert(acc > 0);

timing.measure('io.read', timing.mark());
timing.recordFile('a.nc1', 5, true);
timing.recordFile('b.nc1', 9, true);
timing.recordFile('c.nc1', 7, false);

var summary = timing.summary();
assert.strictEqual(summary.label, 'unit');
assert.strictEqual(summary.files, 3);
assert.strictEqual(summary.failures, 1);
assert.strictEqual(summary.slowest.length, 3);
assert.strictEqual(summary.slowest[0].name, 'b.nc1');
assert.strictEqual(summary.slowest[2].name, 'a.nc1');

var names = summary.stages.map(function (stage) { return stage.name; });
assert(names.indexOf('cpu.busy') >= 0, 'cpu.busy stage missing');
assert(names.indexOf('io.read') >= 0, 'io.read stage missing');
summary.stages.forEach(function (stage) {
	assert(stage.count >= 1);
	assert(isFinite(stage.total) && stage.total >= 0);
	assert(isFinite(stage.avg) && stage.avg >= 0);
	assert(stage.max >= stage.min);
});
ok('aggregates stages with count/total/avg/min/max');

var ended = timing.endBatch();
assert(ended, 'endBatch() returned nothing');
assert.strictEqual(context.__deepnestImportProfile, ended);
assert.strictEqual(ended.files, 3);
ok('endBatch() prints and exposes __deepnestImportProfile');

timing.disable();
assert.strictEqual(timing.enabled, false);
assert.strictEqual(timing.mark(), null);
timing.endBatch();
ok('disable() stops recording');

console.log('');
console.log(passed + ' passed');
