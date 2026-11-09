/*
 * BrowserNfp
 * JavaScript fallback for the native `minkowski` addon.
 *
 * `background.js` only needs the addon for inside NFPs (sheet fit / part in
 * part) and for placed parts that have holes. Outer NFPs are already computed
 * with Clipper's MinkowskiSum in background.js. This module replaces the two
 * synchronous entry points with the same GeometryUtil.noFitPolygon path that
 * the original browser SVGNest code uses.
 *
 * Loaded after background.html's scripts; it overrides the global functions
 * before window.onload starts a job.
 */
(function (root, factory) {
	var api = factory(root);
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	if (root) {
		root.BrowserNfp = api;
	}
})(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : this), function (root) {
	'use strict';

	var CLIPPER_SCALE = 10000000;

	function geometry() {
		return root.GeometryUtil;
	}

	function clipper() {
		return root.ClipperLib;
	}

	function polygonArea(polygon) {
		return geometry().polygonArea(polygon);
	}

	function getFrame(A) {
		var bounds = geometry().getPolygonBounds(A);

		// Expand bounds by 10%, matching background.js.
		bounds.width *= 1.1;
		bounds.height *= 1.1;
		bounds.x -= 0.5 * (bounds.width - (bounds.width / 1.1));
		bounds.y -= 0.5 * (bounds.height - (bounds.height / 1.1));

		var frame = [];
		frame.push({ x: bounds.x, y: bounds.y });
		frame.push({ x: bounds.x + bounds.width, y: bounds.y });
		frame.push({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
		frame.push({ x: bounds.x, y: bounds.y + bounds.height });

		frame.children = [A];
		frame.source = A.source;
		frame.rotation = 0;

		return frame;
	}

	// Clipper uses X/Y instead of x/y.
	function toClipperCoordinates(polygon) {
		var clone = [];
		for (var i = 0; i < polygon.length; i++) {
			clone.push({ X: polygon[i].x, Y: polygon[i].y });
		}
		return clone;
	}

	function toNestCoordinates(polygon, scale) {
		var clone = [];
		for (var i = 0; i < polygon.length; i++) {
			clone.push({ x: polygon[i].X / scale, y: polygon[i].Y / scale });
		}
		return clone;
	}

	// Returns clipper NFP paths: children first, then the outer ring.
	function nfpToClipperCoordinates(nfp, config) {
		var ClipperLib = clipper();
		var clipperNfp = [];
		var i;

		if (nfp.children && nfp.children.length > 0) {
			for (i = 0; i < nfp.children.length; i++) {
				if (polygonArea(nfp.children[i]) < 0) {
					nfp.children[i].reverse();
				}
				var childNfp = toClipperCoordinates(nfp.children[i]);
				ClipperLib.JS.ScaleUpPath(childNfp, config.clipperScale);
				clipperNfp.push(childNfp);
			}
		}

		if (polygonArea(nfp) > 0) {
			nfp.reverse();
		}

		var outerNfp = toClipperCoordinates(nfp);
		ClipperLib.JS.ScaleUpPath(outerNfp, config.clipperScale);
		clipperNfp.push(outerNfp);

		return clipperNfp;
	}

	function innerNfpToClipperCoordinates(nfp, config) {
		var clipperNfp = [];
		for (var i = 0; i < nfp.length; i++) {
			clipperNfp = clipperNfp.concat(nfpToClipperCoordinates(nfp[i], config));
		}
		return clipperNfp;
	}

	function cacheFind(obj, inner) {
		if (root.db && typeof root.db.find === 'function') {
			return root.db.find(obj, inner);
		}
		return null;
	}

	function cacheInsert(obj, inner) {
		if (root.db && typeof root.db.insert === 'function') {
			root.db.insert(obj, inner);
		}
	}

	function jsNfp(A, B, inside, searchEdges) {
		var GeometryUtil = geometry();
		if (!GeometryUtil || !A || !B) {
			return [];
		}
		return GeometryUtil.noFitPolygon(A, B, !!inside, searchEdges !== false) || [];
	}

	function getOuterNfp(A, B, inside) {
		var i;
		var doc;

		if (typeof A.source !== 'undefined' && typeof B.source !== 'undefined') {
			doc = cacheFind({
				A: A.source,
				B: B.source,
				Arotation: A.rotation,
				Brotation: B.rotation
			}, false);
			if (doc) {
				return doc;
			}
		}

		if (inside) {
			var innerList = jsNfp(A, B, true, true);
			if (innerList.length === 0) {
				return null;
			}
			var innerOuter = innerList[0];
			if (polygonArea(innerOuter) > 0) {
				innerOuter.reverse();
			}
			innerOuter.children = innerList.slice(1);
			return innerOuter;
		}

		var list = jsNfp(A, B, false, true);
		if (list.length === 0) {
			return null;
		}

		// The first NFP is guaranteed to be the largest.
		var outer = list[0];
		if (polygonArea(outer) > 0) {
			outer.reverse();
		}

		var children = [];
		if (A.children && A.children.length > 0) {
			for (i = 0; i < A.children.length; i++) {
				var childList = jsNfp(A.children[i], B, false, false);
				if (childList.length > 0) {
					var child = childList[0];
					if (polygonArea(child) < 0) {
						child.reverse();
					}
					children.push(child);
				}
			}
		}
		outer.children = children;

		if (typeof A.source !== 'undefined' && typeof B.source !== 'undefined') {
			cacheInsert({
				A: A.source,
				B: B.source,
				Arotation: A.rotation,
				Brotation: B.rotation,
				nfp: outer
			}, false);
		}

		return outer;
	}

	function getInnerNfp(A, B, config) {
		var i;
		var doc;

		if (typeof A.source !== 'undefined' && typeof B.source !== 'undefined') {
			doc = cacheFind({
				A: A.source,
				B: B.source,
				Arotation: 0,
				Brotation: B.rotation
			}, true);
			if (doc) {
				return doc;
			}
		}

		var frame = getFrame(A);
		var list = jsNfp(frame, B, true, true);
		if (list.length === 0) {
			return null;
		}

		for (i = 0; i < list.length; i++) {
			if (polygonArea(list[i]) > 0) {
				list[i].reverse();
			}
		}

		var holes = [];
		if (A.children && A.children.length > 0) {
			for (i = 0; i < A.children.length; i++) {
				var childList = jsNfp(A.children[i], B, false, false);
				if (childList.length > 0) {
					var hole = childList[0];
					if (polygonArea(hole) < 0) {
						hole.reverse();
					}
					holes.push(hole);
				}
			}
		}

		var result = list;
		if (holes.length > 0) {
			var ClipperLib = clipper();
			var clipperNfp = innerNfpToClipperCoordinates(list, config);
			var clipperHoles = innerNfpToClipperCoordinates(holes, config);
			var finalNfp = new ClipperLib.Paths();
			var clipperInstance = new ClipperLib.Clipper();

			clipperInstance.AddPaths(clipperHoles, ClipperLib.PolyType.ptClip, true);
			clipperInstance.AddPaths(clipperNfp, ClipperLib.PolyType.ptSubject, true);

			if (clipperInstance.Execute(
				ClipperLib.ClipType.ctDifference,
				finalNfp,
				ClipperLib.PolyFillType.pftNonZero,
				ClipperLib.PolyFillType.pftNonZero
			)) {
				if (!finalNfp || finalNfp.length === 0) {
					return null;
				}
				result = [];
				for (i = 0; i < finalNfp.length; i++) {
					result.push(toNestCoordinates(finalNfp[i], config.clipperScale));
				}
			}
		}

		if (typeof A.source !== 'undefined' && typeof B.source !== 'undefined') {
			cacheInsert({
				A: A.source,
				B: B.source,
				Arotation: 0,
				Brotation: B.rotation,
				nfp: result
			}, true);
		}

		return result;
	}

	// Fallback shape for the native addon: an array of polygons, each with a
	// children array. Not used when install() has replaced getOuterNfp.
	function calculateNFP(obj) {
		var list = jsNfp(obj.A, obj.B, false, true);
		var result = [];
		for (var i = 0; i < list.length; i++) {
			var copy = list[i].slice(0);
			copy.children = [];
			result.push(copy);
		}
		return result;
	}

	/*
	 * The original Parallel worker path uses eval.js + importScripts(), which
	 * modern browsers no longer run reliably. Run the pair callback
	 * synchronously in the background iframe instead. This keeps the app
	 * functional for development; large jobs will block the iframe while the
	 * NFP pairs are computed.
	 */
	function installParallelPatch() {
		var Parallel = root.Parallel;
		if (!Parallel || !Parallel.prototype) {
			return;
		}

		Parallel.prototype.map = function (callback) {
			var data = this.data || [];
			var result = [];

			console.log('[browser nfp] computing', data.length, 'pair(s) synchronously');
			for (var i = 0; i < data.length; i++) {
				result.push(callback(data[i], i));
			}

			return {
				then: function (onFulfilled) {
					onFulfilled(result);
					return this;
				},
				catch: function () {
					return this;
				}
			};
		};
	}

	function install(target) {
		target = target || root;
		target.getOuterNfp = getOuterNfp;
		target.getInnerNfp = getInnerNfp;
		target.__nfpAddon = { calculateNFP: calculateNFP };
		installParallelPatch();
		return target;
	}

	if (root && root.GeometryUtil && root.ClipperLib) {
		install(root);
	}

	return {
		CLIPPER_SCALE: CLIPPER_SCALE,
		getFrame: getFrame,
		getOuterNfp: getOuterNfp,
		getInnerNfp: getInnerNfp,
		calculateNFP: calculateNFP,
		install: install
	};
});
