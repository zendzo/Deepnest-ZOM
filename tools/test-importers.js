/*
 * Dependency-free parser tests.
 *
 * Run: node tools/test-importers.js
 *
 * The NC1 reference checks compare this JavaScript port against the DXFs the
 * existing AutoCAD LISP produced for the same NC1 files. They are skipped when
 * the sample folder is not present.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var Nc1 = require('../main/importer/nc1.js');
var DxfMeta = require('../main/importer/dxf-meta.js');
var DxfLabels = require('../main/exporter/dxf-labels.js');

var SAMPLE_DIR = process.env.NC1_SAMPLE_DIR || path.join(
	os.homedir(),
	'OneDrive - Seatrium Ltd',
	'Documents',
	'SAMPLE_NC'
);

var REFERENCE_DIR = path.join(SAMPLE_DIR, '1.DXF-full-attribute');

var CURATED = [
	'SP-0840-0010-PL-0003.nc1',
	'SP-0840-0015-PL-0002.nc1',
	'SP-0840-0010-PL-0005.nc1',
	'SP-G3021-P1A-PL-0012.nc1',
	'SP-G3021-P1C-PL-0020.nc1',
	'SP-G3021-P1D-PL-0027.nc1'
];

var passed = 0;
var skipped = 0;

function ok(name) {
	passed++;
	console.log('ok - ' + name);
}

function skip(name, reason) {
	skipped++;
	console.log('skip - ' + name + ' (' + reason + ')');
}

function firstCode(entity, code) {
	var values = entity.codes[code];
	return values && values.length > 0 ? values[0] : '';
}

function numberOr(value, fallback) {
	var number = parseFloat(value);
	return isFinite(number) ? number : fallback;
}

function readPolylines(text) {
	var entities = DxfMeta.parseEntities(text);
	var polylines = [];
	var current = null;

	for (var i = 0; i < entities.length; i++) {
		var entity = entities[i];
		if (entity.type === 'POLYLINE') {
			current = null;
			if (String(firstCode(entity, 8)).toUpperCase() === 'CUTTING') {
				current = { vertices: [] };
				polylines.push(current);
			}
			continue;
		}
		if (entity.type === 'VERTEX' && current) {
			current.vertices.push({
				x: numberOr(firstCode(entity, 10), 0),
				y: numberOr(firstCode(entity, 20), 0),
				bulge: numberOr(firstCode(entity, 42), 0)
			});
			continue;
		}
		if (entity.type === 'SEQEND') {
			current = null;
		}
	}

	return polylines;
}

function expectedPolylines(part) {
	var result = [];
	for (var i = 0; i < part.contours.length; i++) {
		var vertices = Nc1.contourToPolyline(part.contours[i]);
		var polyline = [];
		for (var j = 0; j < vertices.length; j++) {
			polyline.push({
				x: vertices[j].x,
				y: vertices[j].y,
				bulge: Nc1.segmentBulge(vertices[j], vertices[(j + 1) % vertices.length])
			});
		}
		result.push(polyline);
	}
	return result;
}

function assertClose(actual, expected, tolerance, message) {
	if (Math.abs(actual - expected) > tolerance) {
		assert.fail(message + ': expected ' + expected + ', got ' + actual);
	}
}

function assertPolylinesEqual(actual, expected, name) {
	assert.strictEqual(actual.length, expected.length, name + ': contour count');
	for (var i = 0; i < expected.length; i++) {
		var expectedVertices = expected[i];
		var actualVertices = actual[i].vertices;
		assert.strictEqual(
			actualVertices.length,
			expectedVertices.length,
			name + ': contour ' + i + ' vertex count'
		);
		for (var j = 0; j < expectedVertices.length; j++) {
			assertClose(actualVertices[j].x, expectedVertices[j].x, 1e-5, name + ': contour ' + i + ' vertex ' + j + ' x');
			assertClose(actualVertices[j].y, expectedVertices[j].y, 1e-5, name + ': contour ' + i + ' vertex ' + j + ' y');
			assertClose(actualVertices[j].bulge, expectedVertices[j].bulge, 1e-5, name + ': contour ' + i + ' vertex ' + j + ' bulge');
		}
	}
}

function testDxfMetaAgainstNc1(name) {
	var nc1Path = path.join(SAMPLE_DIR, name);
	var dxfPath = path.join(REFERENCE_DIR, name.replace(/\.nc1$/i, '.dxf'));
	if (!fs.existsSync(nc1Path) || !fs.existsSync(dxfPath)) {
		skip(name + ' metadata', 'sample/reference missing');
		return;
	}

	var part = Nc1.parseNc1(fs.readFileSync(nc1Path), name);
	var meta = DxfMeta.parseDxfMeta(fs.readFileSync(dxfPath, 'utf8'));

	assert.strictEqual(meta.mark, part.mark, name + ': mark');
	assert.strictEqual(meta.quantity, part.header.quantity, name + ': quantity');
	assert.strictEqual(meta.material, part.header.material, name + ': material');
	assert.strictEqual(meta.thickness, part.header.thickness, name + ': thickness');
	ok(name + ' metadata');
}

function testNc1GeometryAgainstDxf(name) {
	var nc1Path = path.join(SAMPLE_DIR, name);
	var dxfPath = path.join(REFERENCE_DIR, name.replace(/\.nc1$/i, '.dxf'));
	if (!fs.existsSync(nc1Path) || !fs.existsSync(dxfPath)) {
		skip(name + ' geometry', 'sample/reference missing');
		return;
	}

	var part = Nc1.parseNc1(fs.readFileSync(nc1Path), name);
	var expected = expectedPolylines(part);
	var actual = readPolylines(fs.readFileSync(dxfPath, 'utf8'));

	assertPolylinesEqual(actual, expected, name);
	ok(name + ' geometry');
}

function testNc1Svg(name) {
	var nc1Path = path.join(SAMPLE_DIR, name);
	if (!fs.existsSync(nc1Path)) {
		skip(name + ' svg', 'sample missing');
		return;
	}

	var part = Nc1.parseNc1(fs.readFileSync(nc1Path), name);
	var rendered = Nc1.nc1ToSvg(part, { curveTolerance: 0.1 });

	assert.ok(/^<svg\b/.test(rendered.svg), name + ': svg root');
	assert.ok(rendered.svg.indexOf('<path') >= 0, name + ': svg paths');
	assert.ok(rendered.width > 0 && rendered.height > 0, name + ': svg dimensions');
	assert.strictEqual(rendered.contourCount, part.contours.length, name + ': svg contour count');
	ok(name + ' svg');
}

function syntheticNc1() {
	return [
		'ST',
		'** TEST.nc1',
		'  PROJECT',
		'  LOT',
		'  PHASE',
		'  TEST-PL-0001',
		'  S355 (5)',
		'  2',
		'  PL8*100',
		'B',
		'AK',
		'  v 0 0',
		'  100 0',
		'  100 50',
		'  0 50',
		'  0 0',
		'IK',
		'  v 10 10',
		'  20 10',
		'  20 20',
		'  10 20',
		'  10 10',
		'BO',
		'  v 50 25 10 0',
		'EN'
	].join('\n');
}

function testSyntheticNc1() {
	var part = Nc1.parseNc1(syntheticNc1(), 'TEST.nc1');
	assert.strictEqual(part.mark, 'TEST-PL-0001');
	assert.strictEqual(part.header.quantity, 2);
	assert.strictEqual(part.header.material, 'S355 (5)');
	assert.strictEqual(part.header.thickness, 8);
	assert.strictEqual(part.contours.length, 3);

	var rendered = Nc1.nc1ToSvg(part, { curveTolerance: 0.1 });
	assert.strictEqual(rendered.contourCount, 3);
	assertClose(rendered.bounds.x, 0, 1e-6, 'synthetic nc1 bounds x');
	assertClose(rendered.bounds.y, 0, 1e-6, 'synthetic nc1 bounds y');
	assertClose(rendered.bounds.maxX, 100, 1e-6, 'synthetic nc1 bounds maxX');
	assertClose(rendered.bounds.maxY, 50, 1e-6, 'synthetic nc1 bounds maxY');
	ok('synthetic NC1 parse + SVG');
}

function syntheticDxfMeta() {
	return [
		'0', 'SECTION', '2', 'ENTITIES',
		'0', 'TEXT', '8', 'TEXT', '62', '2', '10', '50', '20', '25', '40', '10',
		'1', 'TEST-PL-0001',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '2', '20', '45', '40', '5',
		'1', '[N]TEST-PL-0001',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '2', '20', '40', '40', '5',
		'1', '[Q]2',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '2', '20', '35', '40', '5',
		'1', '[M]S355 (5)',
		'0', 'TEXT', '8', 'TEXT', '62', '7', '10', '2', '20', '30', '40', '5',
		'1', '[T]8',
		'0', 'ENDSEC', '0', 'EOF'
	].join('\r\n');
}

function testSyntheticDxfMeta() {
	var meta = DxfMeta.parseDxfMeta(syntheticDxfMeta());
	assert.strictEqual(meta.mark, 'TEST-PL-0001');
	assert.strictEqual(meta.markSource, 'N');
	assert.strictEqual(meta.quantity, 2);
	assert.strictEqual(meta.material, 'S355 (5)');
	assert.strictEqual(meta.thickness, 8);
	ok('synthetic DXF metadata');
}

function testDxfLabelMerge() {
	var dxf = [
		'0', 'SECTION', '2', 'ENTITIES',
		'0', 'TEXT', '8', '0', '62', '0', '10', '1', '20', '2', '40', '0.4', '1', 'TES',
		'0', 'TEXT', '8', '0', '62', '0', '10', '1.5', '20', '2', '40', '0.4', '1', 'T-',
		'0', 'TEXT', '8', '0', '62', '0', '10', '2', '20', '2', '40', '0.4', '1', '001',
		'0', 'ENDSEC', '0', 'EOF'
	].join('\n');

	var result = DxfLabels.rewriteDxfLabels(dxf, ['TEST-001']);
	assert.strictEqual(result.merged, 1);
	assert.strictEqual(result.warnings.length, 0);
	var textCount = (result.text.match(/\n0\nTEXT\n/g) || []).length;
	assert.strictEqual(textCount, 1, 'expected one TEXT entity after merge');
	assert.ok(result.text.indexOf('TEST-001') >= 0, 'merged mark is present');
	ok('DXF label fragment merge');
}

function main() {
	testSyntheticNc1();
	testSyntheticDxfMeta();
	testDxfLabelMerge();

	var nc1Available = fs.existsSync(SAMPLE_DIR);
	if (!nc1Available) {
		skip('NC1 sample folder', SAMPLE_DIR + ' not found');
	}
	if (!fs.existsSync(REFERENCE_DIR)) {
		skip('NC1 reference DXFs', REFERENCE_DIR + ' not found');
	}

	if (nc1Available) {
		for (var i = 0; i < CURATED.length; i++) {
			testDxfMetaAgainstNc1(CURATED[i]);
			testNc1GeometryAgainstDxf(CURATED[i]);
			testNc1Svg(CURATED[i]);
		}
	}

	console.log('\n' + passed + ' passed, ' + skipped + ' skipped');
	if (passed === 0) {
		process.exitCode = 1;
	}
}

try {
	main();
} catch (error) {
	console.error('\nFAIL - ' + error.message);
	console.error(error.stack);
	process.exitCode = 1;
}
