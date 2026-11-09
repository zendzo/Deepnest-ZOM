/*
 * Import CPU baseline for the worker/batch work.
 *
 * Run: node tools/profile-importers.js
 *
 * Measures the local CPU stages that can move to a worker:
 *   - NC1/DSTV parse (Nc1.parseNc1)
 *   - NC1 -> SVG rendering (Nc1.nc1ToSvg)
 *   - DXF TEXT metadata scan (DxfMeta.parseDxfMeta)
 *
 * These are the stages the browser profiler reports as nc1.parse, nc1.toSvg
 * and dxf.meta, but measured with a real clock in Node so the numbers are
 * usable for sizing the import worker pool.
 *
 * Set NC1_SAMPLE_DIR to point at the NC1 sample folder and PROFILE_RUNS to
 * change the repetition count (default 20).
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var performance = require('perf_hooks').performance;

var Nc1 = require('../main/importer/nc1.js');
var DxfMeta = require('../main/importer/dxf-meta.js');

var SAMPLE_DIR = process.env.NC1_SAMPLE_DIR || path.join(
	os.homedir(),
	'OneDrive - Seatrium Ltd',
	'Documents',
	'SAMPLE_NC'
);

var CURATED = [
	'SP-0840-0010-PL-0003.nc1',
	'SP-0840-0015-PL-0002.nc1',
	'SP-0840-0010-PL-0005.nc1',
	'SP-G3021-P1A-PL-0012.nc1',
	'SP-G3021-P1C-PL-0020.nc1',
	'SP-G3021-P1D-PL-0027.nc1'
];

var RUNS = Math.max(1, parseInt(process.env.PROFILE_RUNS || '20', 10) || 20);
var PROJECT_COUNT = 200;

function time(fn) {
	var start = performance.now();
	var result = fn();
	return { ms: performance.now() - start, result: result };
}

function stats(values) {
	var sorted = values.slice(0).sort(function (a, b) { return a - b; });
	var total = 0;
	for (var i = 0; i < values.length; i++) {
		total += values[i];
	}
	return {
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		max: sorted[sorted.length - 1],
		avg: total / values.length
	};
}

function pad(value, width) {
	value = String(value);
	while (value.length < width) {
		value += ' ';
	}
	return value;
}

function fmt(value) {
	return value.toFixed(3);
}

function benchmarkNc1(directory) {
	var rows = [];
	var totals = { parse: [], render: [] };

	CURATED.forEach(function (name) {
		var file = path.join(directory, name);
		if (!fs.existsSync(file)) {
			return;
		}

		var bytes = fs.readFileSync(file);
		var parsed = Nc1.parseNc1(bytes, name);
		var parseRuns = [];
		var renderRuns = [];
		var svgBytes = 0;

		for (var i = 0; i < RUNS; i++) {
			var parse = time(function () {
				return Nc1.parseNc1(bytes, name);
			});
			parseRuns.push(parse.ms);
			totals.parse.push(parse.ms);
		}

		for (i = 0; i < RUNS; i++) {
			var render = time(function () {
				return Nc1.nc1ToSvg(parsed, { curveTolerance: 0.1 });
			});
			renderRuns.push(render.ms);
			totals.render.push(render.ms);
			svgBytes = render.result.svg.length;
		}

		rows.push({
			name: name,
			bytes: bytes.length,
			parse: stats(parseRuns),
			render: stats(renderRuns),
			svgBytes: svgBytes
		});
	});

	return { rows: rows, parse: stats(totals.parse), render: stats(totals.render) };
}

function benchmarkDxfMeta() {
	var dxf = [
		'0', 'SECTION', '2', 'HEADER',
		'9', '$ACADVER', '1', 'AC1009',
		'9', '$INSUNITS', '70', '4',
		'0', 'ENDSEC',
		'0', 'SECTION', '2', 'ENTITIES',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '10', '20', '90', '40', '5', '1', '[N]BATCH-DXF',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '10', '20', '80', '40', '5', '1', '[Q]2',
		'0', 'ENDSEC',
		'0', 'EOF'
	].join('\n');

	var runs = [];
	var meta = null;
	for (var i = 0; i < PROJECT_COUNT; i++) {
		var sample = time(function () {
			return DxfMeta.parseDxfMeta(dxf);
		});
		runs.push(sample.ms);
		meta = sample.result;
	}

	return { stats: stats(runs), meta: meta, bytes: dxf.length, runs: PROJECT_COUNT };
}

console.log('Import CPU baseline (real clock, Node ' + process.version + ')');
console.log('Runs per NC1 stage: ' + RUNS + ', projected batch: ' + PROJECT_COUNT + ' files');
console.log('');

if (!fs.existsSync(SAMPLE_DIR)) {
	console.log('NC1 samples not found: ' + SAMPLE_DIR);
	console.log('Set NC1_SAMPLE_DIR to run the NC1 part of the baseline.');
}
else {
	var nc1 = benchmarkNc1(SAMPLE_DIR);
	if (nc1.rows.length === 0) {
		console.log('No curated NC1 samples found in ' + SAMPLE_DIR);
	}
	else {
		console.log('NC1 parse + render');
		console.log('  ' + pad('file', 28) + pad('bytes', 9) +
			pad('parse min/med', 18) + pad('render min/med', 18) + 'svg bytes');
		nc1.rows.forEach(function (row) {
			console.log('  ' + pad(row.name, 28) + pad(row.bytes, 9) +
				pad(fmt(row.parse.min) + ' / ' + fmt(row.parse.median), 18) +
				pad(fmt(row.render.min) + ' / ' + fmt(row.render.median), 18) +
				row.svgBytes);
		});
		console.log('  median parse=' + fmt(nc1.parse.median) + 'ms, median render=' +
			fmt(nc1.render.median) + 'ms per file');
		console.log('  projected ' + PROJECT_COUNT + ' files, sequential: parse=' +
			fmt(nc1.parse.median * PROJECT_COUNT) + 'ms, render=' +
			fmt(nc1.render.median * PROJECT_COUNT) + 'ms, total=' +
			fmt((nc1.parse.median + nc1.render.median) * PROJECT_COUNT) + 'ms');
		console.log('');
	}
}

var dxf = benchmarkDxfMeta();
console.log('DXF TEXT metadata scan (synthetic file, ' + dxf.bytes + ' bytes, ' + dxf.runs + ' runs)');
console.log('  median=' + fmt(dxf.stats.median) + 'ms, avg=' + fmt(dxf.stats.avg) +
	'ms, max=' + fmt(dxf.stats.max) + 'ms');
console.log('  projected ' + PROJECT_COUNT + ' files: ' + fmt(dxf.stats.median * PROJECT_COUNT) + 'ms');
if (dxf.meta) {
	console.log('  parsed mark=' + dxf.meta.mark + ' quantity=' + dxf.meta.quantity);
}
