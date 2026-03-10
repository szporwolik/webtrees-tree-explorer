/**
 * SP Tree Explorer for webtrees
 * Family Navigator — JSON → Layout → Cards → Canvas connectors
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

/**
 * CSS color tokens cache - initialized once from CSS custom properties
 * Provides theme-portable colors for inline SVG generation
 */
var wtpCSSColors = {
    ringBrokenFill: '#f1f3f5',
    ringBrokenStroke: '#c5c9d1',
    divorceLine: '#e74c3c',
    ringFemaleFill: '#fce7f3',
    ringFemaleStroke: '#f3a2cb',
    ringMaleFill: '#e0f7ff',
    ringMaleStroke: '#61d8f0',
    heartFill: '#f3bfd1',
    heartStroke: '#e8a0b8',
    connectorLine: '#c0c6d0'
};

/**
 * Initialize CSS color tokens from computed styles
 * Attempts to read from .wtp-plugin-root, falls back to document root
 */
function wtpInitCSSColors() {
    var root = document.querySelector('.wtp-plugin-root') || document.documentElement;
    var styles = getComputedStyle(root);
    
    function readToken(name, fallback) {
        var value = styles.getPropertyValue(name).trim();
        return value || fallback;
    }
    
    wtpCSSColors.ringBrokenFill = readToken('--wtp-ring-broken-fill', '#f1f3f5');
    wtpCSSColors.ringBrokenStroke = readToken('--wtp-ring-broken-stroke', '#c5c9d1');
    wtpCSSColors.divorceLine = readToken('--wtp-divorce-line', '#e74c3c');
    wtpCSSColors.ringFemaleFill = readToken('--wtp-ring-female-fill', '#fce7f3');
    wtpCSSColors.ringFemaleStroke = readToken('--wtp-ring-female-stroke', '#f3a2cb');
    wtpCSSColors.ringMaleFill = readToken('--wtp-ring-male-fill', '#e0f7ff');
    wtpCSSColors.ringMaleStroke = readToken('--wtp-ring-male-stroke', '#61d8f0');
    wtpCSSColors.heartFill = readToken('--wtp-heart-fill', '#f3bfd1');
    wtpCSSColors.heartStroke = readToken('--wtp-heart-stroke', '#e8a0b8');
    wtpCSSColors.connectorLine = readToken('--wtp-connector-line', '#c0c6d0');
}

// eslint-disable-next-line no-unused-vars
function FamilyNavigator(cardPrefix, startExpanded, treeData, expandUrl, searchUrl) {
    var nav = this;

    this.cardPrefix     = cardPrefix;
    this.startExpanded  = startExpanded;
    this.treeData       = treeData;     // { nodes:[], edges:[], rootId:'' }
    this.expandUrl      = expandUrl;
    this.searchUrl      = searchUrl;

    // DOM references
    this.container      = document.getElementById(cardPrefix + '_wrap');
    this.canvas         = document.getElementById(cardPrefix + '_canvas');
    this.connCanvas     = document.getElementById(cardPrefix + '_connCanvas');

    // Floating icon overlay — sits outside overflow:hidden container
    this.iconOverlay    = null;
    this.iconCanvas     = null;
    this._createIconOverlay();
    this.loaderIcon     = document.getElementById(cardPrefix + '_loader');
    this.toolbar        = document.getElementById(cardPrefix + '_toolbar');
    this.overlay        = document.getElementById(cardPrefix + '_overlay');
    this.searchInput    = document.getElementById(cardPrefix + '_searchInput');
    this.searchResults  = document.getElementById(cardPrefix + '_searchResults');
    this.searchPanel    = document.getElementById(cardPrefix + '_searchPanel');
    this.searchCancel   = document.getElementById(cardPrefix + '_searchCancel');
    this.focusChip      = document.getElementById(cardPrefix + '_focusChip');
    this.focusAvatar    = document.getElementById(cardPrefix + '_focusAvatar');
    this.focusName      = document.getElementById(cardPrefix + '_focusName');

    // Move search panel to document.body so it escapes overflow/backdrop-filter clipping
    if (this.searchPanel) {
        // Copy theme CSS custom properties from the plugin root to the panel
        var pluginRoot = this.container ? this.container.closest('.wtp-plugin-root') : null;
        if (pluginRoot) {
            var rootStyles = getComputedStyle(pluginRoot);
            var themeVars = ['--wtp-bg', '--wtp-bg-elevated', '--wtp-text', '--wtp-text-muted',
                '--wtp-border', '--wtp-accent', '--wtp-accent-hover', '--wtp-focus',
                '--wtp-shadow-md', '--wtp-radius-sm'];
            for (var v = 0; v < themeVars.length; v++) {
                var val = rootStyles.getPropertyValue(themeVars[v]);
                if (val) this.searchPanel.style.setProperty(themeVars[v], val.trim());
            }
        }
        document.body.appendChild(this.searchPanel);
    }

    // Selected person xref from search
    this.selectedXref   = '';
    this.latestSearchResults = [];
    this.searchLookup = {};

    // Zoom / pan state
    this.zoomLevel      = 1.0;
    this.zoomMin        = 0.15;
    this.zoomMax        = 2.0;
    this.zoomStep       = 0.1;
    this.panX           = 0;
    this.panY           = 0;

    // Layout constants — match CSS rendered widths exactly for connector precision
    this.CARD_W         = 206;  // card width (matches CSS .sp-card width)
    this.CARD_H         = 82;   // approximate card height
    this.COUPLE_GAP     = 36;   // gap between person card and spouse card (couple-line with rings/dates)
    this.H_GAP          = 24;   // horizontal gap between sibling subtrees
    this.FAMILY_GROUP_GAP = 84; // extra spacing between children from different marriages
    this.MULTI_SPOUSE_SEP = 34; // extra visual gap before each additional spouse group
    this.V_GAP          = 76;   // vertical gap between generations (global spacing to preserve same-level generations)
    this.CHILD_TOP_CLEARANCE = 6; // clearance above child card so connector doesn't touch
    this.FORK_SOURCE_OFFSET = 0; // keep fork continuous with couple-line to avoid visible gaps
    this.LAZY_W         = 192;
    this.LAZY_H         = 36;

    // Layout data — filled by layoutTree()
    this.nodeMap        = {};   // id -> node data (from JSON)
    this.layoutMap      = {};   // id -> { x, y, w, h, coupleW } (computed positions)
    this.childrenMap    = {};   // parentId -> [childId, ...]
    this.parentEdges    = {};   // childId -> [edge, ...] (multiple parents possible)
    this.edgeMap        = {};   // stores edge metadata

    // Active ancestor lines (for ancestor switching)
    this.activeLines    = {};   // nodeId -> lineIndex (0 = self/default, 1 = spouse)

    // Track the currently displayed root person xref (for share links)
    this.currentRootXref = '';

    // Sources visibility state (default: off)
    this.showSources = false;

    // DOM card references
    this.cardElements   = {};   // nodeId -> DOM element

    // Build indexes and render
    this.buildIndex(this.treeData);

    // Determine the actual target xref (may differ from root person due to gender swap)
    var urlParams = new URL(window.location.href).searchParams;
    var urlXref = urlParams.get('xref');
    this._setCurrentXref(urlXref);

    // Restore sources state from URL
    if (urlParams.get('sources') === '1') {
        this.showSources = true;
    }

    this.measureAndRender();

    // Init interactions
    this.initPanZoom();
    this.initToolbar();
    this.initSearch();

    // Center on root and hide overlay
    if (this.startExpanded) {
        this.focusOrigin();
    }
    this.hideOverlay();
    this._updateFocusPersonBox();
}

/**
 * Create the icon overlay layer (sibling of container, not clipped).
 */
FamilyNavigator.prototype._createIconOverlay = function () {
    if (!this.container || !this.container.parentNode) return;
    var overlay = document.createElement('div');
    overlay.className = 'sp-icon-overlay';
    var inner = document.createElement('div');
    inner.className = 'sp-icon-overlay-canvas';
    overlay.appendChild(inner);
    // Insert right after the navigator container (sibling, not clipped)
    this.container.parentNode.insertBefore(overlay, this.container.nextSibling);
    this.iconOverlay = overlay;
    this.iconCanvas = inner;
    this._syncIconOverlayBounds();
};

/**
 * Match overlay bounds to the navigator container.
 */
FamilyNavigator.prototype._syncIconOverlayBounds = function () {
    if (!this.iconOverlay || !this.container) return;
    this.iconOverlay.style.top = this.container.offsetTop + 'px';
    this.iconOverlay.style.left = this.container.offsetLeft + 'px';
    this.iconOverlay.style.width = this.container.offsetWidth + 'px';
    this.iconOverlay.style.height = this.container.offsetHeight + 'px';
};

// ==========================================================================
// INDEX BUILDING — build adjacency maps from flat node/edge arrays
// ==========================================================================

FamilyNavigator.prototype.buildIndex = function (data) {
    var i, node, edge;
    this.nodeMap = {};
    this.childrenMap = {};
    this.parentEdges = {}; // childId -> [edge, ...] (multiple ancestors possible)
    this.edgeMap = {};

    for (i = 0; i < data.nodes.length; i++) {
        node = data.nodes[i];
        this.nodeMap[node.id] = node;
    }

    for (i = 0; i < data.edges.length; i++) {
        edge = data.edges[i];
        var key = edge.from + '->' + edge.to;
        this.edgeMap[key] = edge;

        if (!this.childrenMap[edge.from]) {
            this.childrenMap[edge.from] = [];
        }
        this.childrenMap[edge.from].push(edge.to);

        if (!this.parentEdges[edge.to]) {
            this.parentEdges[edge.to] = [];
        }
        this.parentEdges[edge.to].push(edge);
    }

    // Sort children by familyIndex first (group families together),
    // then by birth date so siblings appear oldest (left) to youngest (right).
    var self = this;
    for (var parentId in this.childrenMap) {
        this.childrenMap[parentId].sort(function (a, b) {
            // Sort by familyIndex first
            var eaKey = parentId + '->' + a;
            var ebKey = parentId + '->' + b;
            var ea = self.edgeMap[eaKey];
            var eb = self.edgeMap[ebKey];
            var fa = (ea && ea.familyIndex !== undefined) ? ea.familyIndex : -1;
            var fb = (eb && eb.familyIndex !== undefined) ? eb.familyIndex : -1;
            if (fa !== fb) return fa - fb;

            // Then by birth date
            var na = self.nodeMap[a];
            var nb = self.nodeMap[b];
            var ja = (na && na.childBirthJd) || 0;
            var jb = (nb && nb.childBirthJd) || 0;
            if (ja === 0 && jb === 0) return 0;
            if (ja === 0) return 1;
            if (jb === 0) return -1;
            return ja - jb;
        });
    }
};

// ==========================================================================
// TREE LAYOUT ENGINE — computes x,y for every node
//
// Strategy: bottom-up sizing pass, then top-down positioning pass.
// The root of the visual tree is the topmost ancestor; origin is somewhere
// in the middle. We follow edges to find the visual tree structure.
// ==========================================================================

/**
 * Find visual root: walk up from rootId through visible parent edges until no parent.
 */
FamilyNavigator.prototype.findVisualRoot = function () {
    var current = this.treeData.rootId;
    var visited = {};
    while (true) {
        if (visited[current]) break; // prevent cycles
        visited[current] = true;
        var parents = this.getVisibleParents(current);
        if (parents.length === 0) break;
        current = parents[0]; // follow the first visible parent
    }
    return current;
};

/**
 * Get visible children for a node, respecting ancestor line switches.
 * For ancestor-direction edges, only show the active line.
 */
FamilyNavigator.prototype.getVisibleChildren = function (nodeId) {
    var children = this.childrenMap[nodeId];
    if (!children) return [];

    var result = [];
    for (var i = 0; i < children.length; i++) {
        var childId = children[i];
        var edgeKey = nodeId + '->' + childId;
        var edge = this.edgeMap[edgeKey];

        // Check if this edge has a lineIndex for ancestor switching
        if (edge && edge.lineIndex !== undefined) {
            var parentNode = this.nodeMap[nodeId];
            // Check the CHILD node (the one below, which has ancestorLines)
            var childNode = this.nodeMap[childId];
            if (childNode && childNode.hasMultipleAncestorLines) {
                var activeLine = this.activeLines[childId] || 0;
                if (edge.lineIndex !== activeLine) {
                    continue; // Skip this ancestor line (hidden)
                }
            }
        }

        result.push(childId);
    }
    return result;
};

/**
 * Get the parents of a node that are visible (respecting ancestor line switching).
 */
FamilyNavigator.prototype.getVisibleParents = function (nodeId) {
    var edges = this.parentEdges[nodeId];
    if (!edges) return [];

    var result = [];
    var node = this.nodeMap[nodeId];

    for (var i = 0; i < edges.length; i++) {
        var edge = edges[i];

        // Check ancestor line visibility
        if (node && node.hasMultipleAncestorLines && edge.lineIndex !== undefined) {
            var activeLine = this.activeLines[nodeId] || 0;
            if (edge.lineIndex !== activeLine) continue;
        }

        result.push(edge.from);
    }
    return result;
};

/**
 * Compute subtree width bottom-up.
 * Returns the width needed for the subtree rooted at nodeId.
 */
FamilyNavigator.prototype.measureSubtree = function (nodeId) {
    var node = this.nodeMap[nodeId];
    if (!node) return 0;

    var nodeW = this.nodeWidth(nodeId);
    var children = this.getVisibleChildren(nodeId);

    if (children.length === 0) {
        this.layoutMap[nodeId] = { w: nodeW, subtreeW: nodeW };
        return nodeW;
    }

    var childrenTotalW = 0;
    for (var i = 0; i < children.length; i++) {
        if (i > 0) {
            childrenTotalW += this.H_GAP;
            // Large gap between children from different families
            var prevFi = this._childFamilyIndex(nodeId, children[i - 1]);
            var curFi  = this._childFamilyIndex(nodeId, children[i]);
            if (prevFi !== curFi && prevFi >= 0 && curFi >= 0) {
                childrenTotalW += this.FAMILY_GROUP_GAP;
            }
        }
        childrenTotalW += this.measureSubtree(children[i]);
    }

    var subtreeW = Math.max(nodeW, childrenTotalW);
    this.layoutMap[nodeId] = { w: nodeW, subtreeW: subtreeW };
    return subtreeW;
};

/**
 * Get the visual width of a node (couple = person + spouse + gap).
 */
FamilyNavigator.prototype.nodeWidth = function (nodeId) {
    var node = this.nodeMap[nodeId];
    if (!node) return 0;
    if (node.type === 'lazy') return this.LAZY_W;
    // Use measured width if available (accounts for wide couple lines with dates)
    if (this._measuredWidths && this._measuredWidths[nodeId]) {
        return this._measuredWidths[nodeId];
    }
    if (node.families && node.families.length > 0) {
        var w = this.CARD_W;
        for (var fi = 0; fi < node.families.length; fi++) {
            w += this.COUPLE_GAP + this.CARD_W;
        }
        return w;
    }
    return this.CARD_W;
};

/**
 * Get the familyIndex for an edge from parentId to childId.
 * Returns -1 if no familyIndex is set (ancestor edges, etc.).
 */
FamilyNavigator.prototype._childFamilyIndex = function (parentId, childId) {
    var key = parentId + '->' + childId;
    var edge = this.edgeMap[key];
    if (edge && edge.familyIndex !== undefined) return edge.familyIndex;
    return -1;
};

/**
 * Get the visual height of a node.
 * Uses measured height if available, otherwise falls back to CARD_H.
 */
FamilyNavigator.prototype.nodeHeight = function (nodeId) {
    var node = this.nodeMap[nodeId];
    if (!node) return 0;
    if (node.type === 'lazy') return this.LAZY_H;
    if (this._measuredHeights && this._measuredHeights[nodeId]) {
        return this._measuredHeights[nodeId];
    }
    return this.CARD_H;
};

/**
 * Two-pass rendering: create cards off-screen to measure real heights,
 * then re-layout with actual dimensions and position.
 */
FamilyNavigator.prototype.measureAndRender = function () {
    if (!this.canvas) return;

    // Pass 1: Create all card elements in the DOM to measure their heights
    // Reset transform so measurements are unscaled
    var savedTransform = this.canvas.style.transform;
    this.canvas.style.transform = 'none';
    this.canvas.innerHTML = '';
    this.canvas.style.width = '10000px';
    this.canvas.style.height = '10000px';
    this._measuredHeights = {};
    this._measuredWidths = {};
    var tempElements = {};

    for (var id in this.nodeMap) {
        var node = this.nodeMap[id];
        var el = this.createCardElement(node, { x: 0, y: 0 });
        if (el) {
            this.canvas.appendChild(el);
            tempElements[id] = el;
        }
    }

    // Force layout for measurement
    // (getBoundingClientRect forces the browser to compute layout)
    for (var id in tempElements) {
        var rect = tempElements[id].getBoundingClientRect();
        this._measuredHeights[id] = Math.ceil(rect.height);
        this._measuredWidths[id] = Math.ceil(rect.width);
    }

    // Clear temporary elements and restore transform
    this.canvas.innerHTML = '';
    this.canvas.style.transform = savedTransform;

    // Pass 2: Layout with real heights, then render and position
    this.layoutTree();
    this.render();
};

/**
 * Top-down positioning: assign x, y to each node.
 * The tree is drawn top-down: visual root at top, origin in middle, children below.
 */
FamilyNavigator.prototype.positionSubtree = function (nodeId, x, y) {
    var layout = this.layoutMap[nodeId];
    if (!layout) return;

    var nodeW = layout.w;
    var subtreeW = layout.subtreeW;
    var nodeH = this.nodeHeight(nodeId);

    // Center the node within its subtree width
    var nodeCenterX = x + subtreeW / 2;
    var nodeX = nodeCenterX - nodeW / 2;

    layout.x = nodeX;
    layout.y = y;
    layout.h = nodeH;
    layout.centerX = nodeCenterX;

    // Position children below
    var children = this.getVisibleChildren(nodeId);
    if (children.length === 0) return;

    var childrenTotalW = 0;
    for (var i = 0; i < children.length; i++) {
        if (i > 0) {
            childrenTotalW += this.H_GAP;
            var prevFi = this._childFamilyIndex(nodeId, children[i - 1]);
            var curFi  = this._childFamilyIndex(nodeId, children[i]);
            if (prevFi !== curFi && prevFi >= 0 && curFi >= 0) {
                childrenTotalW += this.FAMILY_GROUP_GAP;
            }
        }
        childrenTotalW += this.layoutMap[children[i]].subtreeW;
    }

    var childY = y + nodeH + this.V_GAP;
    var childX = nodeCenterX - childrenTotalW / 2;

    // First pass: position all children
    for (var i = 0; i < children.length; i++) {
        var cid = children[i];
        var cLayout = this.layoutMap[cid];
        this.positionSubtree(cid, childX, childY);
        var gap = this.H_GAP;
        if (i + 1 < children.length) {
            var prevFi = this._childFamilyIndex(nodeId, children[i]);
            var nextFi = this._childFamilyIndex(nodeId, children[i + 1]);
            if (prevFi !== nextFi && prevFi >= 0 && nextFi >= 0) {
                gap += this.FAMILY_GROUP_GAP;
            }
        }
        childX += cLayout.subtreeW + gap;
    }

    // Second pass: ensure no children overlap with their siblings
    // Find the max height among direct children and push grandchildren down
    this._alignChildRow(children);
};

/**
 * Ensure sibling nodes at the same Y level have consistent child-row placement.
 * If siblings have different heights, shift subtrees of shorter siblings down
 * so their children don't overlap with taller siblings.
 */
FamilyNavigator.prototype._alignChildRow = function (siblingIds) {
    if (siblingIds.length < 2) return;

    // Find the maximum height among siblings at this level
    var maxH = 0;
    for (var i = 0; i < siblingIds.length; i++) {
        var l = this.layoutMap[siblingIds[i]];
        if (l && l.h > maxH) maxH = l.h;
    }

    // Shift children of shorter siblings down to align with the tallest sibling's bottom
    for (var i = 0; i < siblingIds.length; i++) {
        var l = this.layoutMap[siblingIds[i]];
        if (!l) continue;
        var diff = maxH - l.h;
        if (diff > 0) {
            // Shift all descendants of this node down by diff
            this._shiftSubtree(siblingIds[i], diff, true);
        }
    }
};

/**
 * Shift a subtree vertically by dy pixels.
 * @param {boolean} childrenOnly - if true, only shift children, not the node itself
 */
FamilyNavigator.prototype._shiftSubtree = function (nodeId, dy, childrenOnly) {
    if (!childrenOnly) {
        var l = this.layoutMap[nodeId];
        if (l && l.y !== undefined) {
            l.y += dy;
        }
    }
    var children = this.getVisibleChildren(nodeId);
    for (var i = 0; i < children.length; i++) {
        this._shiftSubtree(children[i], dy, false);
    }
};

/**
 * Main layout entry point.
 */
FamilyNavigator.prototype.layoutTree = function () {
    this.layoutMap = {};

    var visualRoot = this.findVisualRoot();
    this.measureSubtree(visualRoot);
    this.positionSubtree(visualRoot, 0, 0);

    // Normalize: shift everything so min x/y = padding
    var padding = 40;
    var minX = Infinity, minY = Infinity;
    for (var id in this.layoutMap) {
        var l = this.layoutMap[id];
        if (l.x !== undefined) {
            if (l.x < minX) minX = l.x;
            if (l.y < minY) minY = l.y;
        }
    }
    var dx = padding - minX;
    var dy = padding - minY;
    for (var id in this.layoutMap) {
        var l = this.layoutMap[id];
        if (l.x !== undefined) {
            l.x += dx;
            l.y += dy;
            l.centerX += dx;
        }
    }
};

/**
 * Shift ancestor spines so that father's ancestors lean left
 * (above the left/person card) and mother's ancestors lean right
 * (above the right/spouse card).
 */
FamilyNavigator.prototype._adjustAncestorDirection = function () {
    for (var id in this.nodeMap) {
        var node = this.nodeMap[id];
        if (!node || !node.hasMultipleAncestorLines || !node.families || node.families.length === 0) continue;

        var activeLine = this.activeLines[id] || 0;
        var layout = this.layoutMap[id];
        if (!layout || layout.x === undefined) continue;

        // Target card center — where the connector should point
        var targetX;
        if (activeLine === 0) {
            // Father's line → left (person) card center
            targetX = layout.x + this.CARD_W / 2;
        } else {
            // Mother's line → right (first spouse) card center
            // Use DOM measurement for accurate position
            var wrapper = this.cardElements[id];
            if (wrapper) {
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                if (lines.length > 0 && lines[0].nextElementSibling) {
                    var sCard = lines[0].nextElementSibling;
                    targetX = layout.x + sCard.offsetLeft + sCard.offsetWidth / 2;
                } else {
                    targetX = layout.x + this.CARD_W + this.COUPLE_GAP + this.CARD_W / 2;
                }
            } else {
                targetX = layout.x + this.CARD_W + this.COUPLE_GAP + this.CARD_W / 2;
            }
        }

        // Walk up ancestor spine collecting all ancestor IDs
        var spineIds = [];
        var current = id;
        var visited = {};
        while (true) {
            var parents = this.getVisibleParents(current);
            if (parents.length === 0) break;
            var pid = parents[0];
            if (visited[pid]) break;
            visited[pid] = true;
            spineIds.push(pid);
            current = pid;
        }

        if (spineIds.length === 0) continue;

        // Shift all spine ancestors so the first ancestor's center aligns with targetX
        var firstLayout = this.layoutMap[spineIds[0]];
        if (!firstLayout || firstLayout.x === undefined) continue;

        var dx = targetX - firstLayout.centerX;
        if (Math.abs(dx) < 1) continue;

        for (var i = 0; i < spineIds.length; i++) {
            var sl = this.layoutMap[spineIds[i]];
            if (sl && sl.x !== undefined) {
                sl.x += dx;
                sl.centerX += dx;
            }
        }
    }
};

// ==========================================================================
// RENDER — create HTML cards and draw canvas connectors
// ==========================================================================

FamilyNavigator.prototype.render = function () {
    if (!this.canvas) return;

    // Clear existing cards
    this.canvas.innerHTML = '';
    this.cardElements = {};

    // Calculate canvas size
    var maxX = 0, maxY = 0;
    for (var id in this.layoutMap) {
        var l = this.layoutMap[id];
        if (l.x !== undefined) {
            var right = l.x + l.w;
            var bottom = l.y + l.h;
            if (right > maxX) maxX = right;
            if (bottom > maxY) maxY = bottom;
        }
    }
    var canvasW = maxX + 80;
    var canvasH = maxY + 80;

    this.canvas.style.width = canvasW + 'px';
    this.canvas.style.height = canvasH + 'px';

    // Render all cards
    for (var id in this.layoutMap) {
        var node = this.nodeMap[id];
        var layout = this.layoutMap[id];
        if (!node || layout.x === undefined) continue;

        var el = this.createCardElement(node, layout);
        if (el) {
            this.canvas.appendChild(el);
            this.cardElements[id] = el;
        }
    }

    // Draw connectors on canvas
    this.drawConnectors(canvasW, canvasH);

    // Render floating ancestor icons in overlay
    this._renderIconOverlay(canvasW, canvasH);
};

/**
 * Create an HTML card element for a node.
 */
FamilyNavigator.prototype.createCardElement = function (node, layout) {
    if (node.type === 'lazy') {
        return this.createLazyElement(node, layout);
    }

    if (node.type !== 'couple') return null;

    var wrapper = document.createElement('div');
    wrapper.className = 'sp-couple-wrapper';
    wrapper.style.position = 'absolute';
    wrapper.style.left = layout.x + 'px';
    wrapper.style.top = layout.y + 'px';
    wrapper.dataset.nodeId = node.id;

    // Person card
    var personCard = this.createPersonCard(node.person, node.isOrigin);
    wrapper.appendChild(personCard);

    // Families (spouse cards with couple lines)
    var spouseCards = [];
    if (node.families && node.families.length > 0) {
        var familyCount = node.families.length;
        for (var fi = 0; fi < node.families.length; fi++) {
            var fam = node.families[fi];
            var lineEl = this.createCoupleLine(fam, node.id, fi, familyCount);

            // Extra spacing before each additional marriage to separate
            // descendant connector groups from different spouse families.
            if (fi > 0 && familyCount > 1) {
                lineEl.style.marginLeft = this.MULTI_SPOUSE_SEP + 'px';
            }

            // No vertical stagger for multi-marriage — all at same level
            wrapper.appendChild(lineEl);

            var sCard = null;
            if (fam.spouse) {
                sCard = this.createPersonCard(fam.spouse, false);
            } else {
                // Family with no spouse record — unknown placeholder
                sCard = this.createPersonCard({ sex: 'U', isUnknown: true }, false);
            }
            wrapper.appendChild(sCard);
            spouseCards.push({ card: sCard, family: fam, index: fi });
        }
    }

    // Navigation icons — navigate to person/spouse to re-center tree on them
    var personHasParents = node.personHasParents;

    // Check which ancestor connections are actually visible (respecting active line switching)
    var personAncestorsVisible = false;
    var spouseAncestorsVisible = false;
    var parentEdgesHere = this.parentEdges[node.id] || [];
    for (var ei = 0; ei < parentEdgesHere.length; ei++) {
        var pe = parentEdgesHere[ei];
        // Only count as visible if the parent node is actually positioned (visible in tree)
        var parentLayout = this.layoutMap[pe.from];
        if (!parentLayout || parentLayout.x === undefined) continue;
        if (pe.lineIndex !== undefined) {
            // Ancestor-line edge: lineIndex directly indicates which side
            if (pe.lineIndex === 1) {
                spouseAncestorsVisible = true;
            } else {
                personAncestorsVisible = true;
            }
        } else {
            // Downward parent-child edge: use originalChildXref to find which side
            var oxref = node.originalChildXref;
            var firstSpouse = (node.families && node.families.length > 0) ? node.families[0].spouse : null;
            if (oxref && firstSpouse && firstSpouse.xref === oxref) {
                spouseAncestorsVisible = true;
            } else {
                personAncestorsVisible = true;
            }
        }
    }

    // Store ancestor-icon metadata on the wrapper for overlay rendering
    wrapper._ancestorIcons = [];
    if (personHasParents && !personAncestorsVisible) {
        // Find parent family xref from ancestorLines (type='self')
        var selfLine = null;
        var aLines = node.ancestorLines || [];
        for (var li = 0; li < aLines.length; li++) {
            if (aLines[li].type === 'self') { selfLine = aLines[li]; break; }
        }
        wrapper._ancestorIcons.push({
            xref: node.person.xref, target: 'person',
            nodeId: node.id,
            familyXref: selfLine ? selfLine.familyXref : '',
            childXref: node.person.xref,
            lineIndex: 0
        });
    }
    for (var si = 0; si < spouseCards.length; si++) {
        var sc = spouseCards[si];
        if (sc.family.spouse && sc.family.spouseHasParents) {
            if (si === 0 && spouseAncestorsVisible) continue;
            wrapper._ancestorIcons.push({
                xref: sc.family.spouse.xref, target: 'spouse', index: si,
                nodeId: node.id,
                familyXref: sc.family.spouseParentFamilyXref || '',
                childXref: sc.family.spouse.xref,
                lineIndex: 1
            });
        }
    }

    return wrapper;
};

/**
 * Create a single person card DOM element.
 */
FamilyNavigator.prototype.createPersonCard = function (personData, isOrigin) {
    var nav = this;
    var genderClass = personData.sex === 'M' ? 'sp-male' : (personData.sex === 'F' ? 'sp-female' : 'sp-unknown');
    var card = document.createElement('div');
    card.className = 'sp-card ' + genderClass + (isOrigin ? ' sp-origin' : '') + (personData.isUnknown ? ' sp-card-unknown' : '');
    card.dataset.xref = personData.xref || '';

    // Unknown person — simplified card with ? icon
    if (personData.isUnknown) {
        var person = document.createElement('div');
        person.className = 'sp-person';
        var qMark = document.createElement('div');
        qMark.className = 'sp-unknown-icon';
        qMark.textContent = '?';
        person.appendChild(qMark);
        card.appendChild(person);
        return card;
    }

    // Black ribbon for deceased persons
    if (personData.isDead) {
        var ribbon = document.createElement('span');
        ribbon.className = 'sp-deceased-ribbon';
        card.appendChild(ribbon);
    }

    // Person info
    var person = document.createElement('div');
    person.className = 'sp-person';

    // Avatar — link to profile (has photo) or media tab (no photo)
    var avatarWrap = document.createElement('a');
    avatarWrap.className = 'sp-avatar-wrap';
    avatarWrap.target = '_blank';
    avatarWrap.rel = 'noopener';
    if (personData.thumb) {
        avatarWrap.href = personData.url;
        avatarWrap.title = personData.name;
        var img = document.createElement('img');
        img.className = 'sp-avatar';
        img.src = personData.thumb;
        img.alt = personData.name;
        img.loading = 'lazy';
        avatarWrap.appendChild(img);
    } else {
        avatarWrap.href = personData.url + '#media';
        avatarWrap.title = 'Add photo';
        avatarWrap.classList.add('sp-avatar-placeholder');
    }
    person.appendChild(avatarWrap);

    // Info (name + dates + parent ages at birth)
    var info = document.createElement('div');
    info.className = 'sp-info';

    var nameLink = document.createElement('a');
    nameLink.className = 'sp-name';
    nameLink.href = personData.url;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener';
    nameLink.setAttribute('aria-label', 'View ' + personData.name + ' profile');
    
    var nameStrong = document.createElement('strong');
    nameStrong.textContent = personData.name;
    nameLink.appendChild(nameStrong);
    info.appendChild(nameLink);

    var years = document.createElement('span');
    years.className = 'sp-years';
    years.textContent = personData.dateLine || '';
    if (personData.dateLineQuality) {
        years.classList.add('sp-years-' + personData.dateLineQuality);
    }

    var placeTitleParts = [];
    if (personData.birthPlace) placeTitleParts.push('Birth place: ' + personData.birthPlace);
    if (personData.deathPlace) placeTitleParts.push('Death place: ' + personData.deathPlace);
    if (placeTitleParts.length > 0) {
        years.title = placeTitleParts.join(' | ');
        var placeMarker = document.createElement('span');
        placeMarker.className = 'sp-place-marker';
        placeMarker.innerHTML = '<svg viewBox="0 0 12 16" width="10" height="13" aria-hidden="true"><path d="M6 0C2.7 0 0 2.5 0 5.6 0 9.8 6 16 6 16s6-6.2 6-10.4C12 2.5 9.3 0 6 0zm0 7.6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="currentColor"/></svg>';
        years.appendChild(placeMarker);
    }
    info.appendChild(years);

    var hasFatherAge = Number.isFinite(personData.fatherAgeAtBirth);
    var hasMotherAge = Number.isFinite(personData.motherAgeAtBirth);
    if (hasFatherAge || hasMotherAge) {
        var parentAges = document.createElement('span');
        parentAges.className = 'sp-parent-ages';

        if (hasFatherAge) {
            var fatherAge = document.createElement('span');
            fatherAge.className = 'sp-parent-age sp-parent-age-father';
            fatherAge.title = 'Father\'s age at birth: ' + personData.fatherAgeAtBirth;

            var fatherIcon = document.createElement('span');
            fatherIcon.className = 'sp-parent-age-icon';
            fatherIcon.textContent = '\u2642';

            var fatherValue = document.createElement('span');
            fatherValue.className = 'sp-parent-age-value';
            fatherValue.textContent = String(personData.fatherAgeAtBirth);

            fatherAge.appendChild(fatherIcon);
            fatherAge.appendChild(fatherValue);
            parentAges.appendChild(fatherAge);
        }

        if (hasMotherAge) {
            var motherAge = document.createElement('span');
            motherAge.className = 'sp-parent-age sp-parent-age-mother';
            motherAge.title = 'Mother\'s age at birth: ' + personData.motherAgeAtBirth;

            var motherIcon = document.createElement('span');
            motherIcon.className = 'sp-parent-age-icon';
            motherIcon.textContent = '\u2640';

            var motherValue = document.createElement('span');
            motherValue.className = 'sp-parent-age-value';
            motherValue.textContent = String(personData.motherAgeAtBirth);

            motherAge.appendChild(motherIcon);
            motherAge.appendChild(motherValue);
            parentAges.appendChild(motherAge);
        }

        info.appendChild(parentAges);
    }

    person.appendChild(info);
    card.appendChild(person);

    // Actions row
    var actions = document.createElement('div');
    actions.className = 'sp-card-actions';

    var actionsLeft = document.createElement('div');
    actionsLeft.className = 'sp-card-actions-left';

    var sourceCount = Number.isFinite(personData.sourceCount) ? personData.sourceCount : 0;
    var noteCount = Number.isFinite(personData.noteCount) ? personData.noteCount : 0;
    var mediaCount = Number.isFinite(personData.mediaCount) ? personData.mediaCount : 0;

    function quickAction(url, label, svgIcon, count) {
        if (!url) return null;
        var link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.className = 'sp-card-action-link';
        if (count > 0) link.classList.add('sp-has-data');
        link.title = label + (count > 0 ? ' (' + count + ')' : '');
        link.setAttribute('aria-label', label + ' for ' + personData.name);
        link.innerHTML = svgIcon;
        if (count > 0) {
            var badge = document.createElement('span');
            badge.className = 'sp-action-count';
            badge.textContent = count;
            if (!nav.showSources) badge.style.display = 'none';
            link.appendChild(badge);
        }
        return link;
    }

    var srcIcon = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M2 1h8l4 4v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 1v4h4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    var noteIcon = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="5" x2="12" y2="5" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="11" x2="9" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>';
    var mediaIcon = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="6.5" r="1.5" fill="currentColor"/><path d="M1.5 11l3-3 2 2 3-4 4 5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    var personUrl = personData.url || '';
    var addSourceLink = quickAction(personUrl ? personUrl + '#sources_tab' : '', 'Sources', srcIcon, sourceCount);
    var addNoteLink = quickAction(personUrl ? personUrl + '#notes' : '', 'Notes', noteIcon, noteCount);
    var addMediaLink = quickAction(personUrl ? personUrl + '#media' : '', 'Media', mediaIcon, mediaCount);
    if (addSourceLink) actionsLeft.appendChild(addSourceLink);
    if (addNoteLink) actionsLeft.appendChild(addNoteLink);
    if (addMediaLink) actionsLeft.appendChild(addMediaLink);

    actions.appendChild(actionsLeft);

    var actionsRight = document.createElement('div');
    actionsRight.className = 'sp-card-actions-right';

    // 1. Quick add note button
    if (personData.addNoteUrl) {
        var addNoteBtn = document.createElement('a');
        addNoteBtn.href = personData.addNoteUrl;
        addNoteBtn.target = '_blank';
        addNoteBtn.rel = 'noopener';
        addNoteBtn.className = 'sp-card-action-btn';
        addNoteBtn.title = 'Add note';
        addNoteBtn.setAttribute('aria-label', 'Add note for ' + personData.name);
        addNoteBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="8" y1="5" x2="8" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        actionsRight.appendChild(addNoteBtn);
    }

    // 2. Edit family (relatives tab)
    if (personData.url) {
        var editFamilyLink = document.createElement('a');
        editFamilyLink.href = personData.url + '#tab-relatives';
        editFamilyLink.target = '_blank';
        editFamilyLink.rel = 'noopener';
        editFamilyLink.className = 'sp-card-action-btn';
        editFamilyLink.title = 'Edit family';
        editFamilyLink.setAttribute('aria-label', 'Edit family for ' + personData.name);
        editFamilyLink.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="5" cy="4" r="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1 13c0-2.5 2-4 4-4s4 1.5 4 4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="4.5" r="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 13c0-2 1.3-3.2 2.8-3.2 .8 0 1.5.3 2 .8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
        actionsRight.appendChild(editFamilyLink);
    }

    // 3. Edit person
    if (personData.url) {
        var viewLink = document.createElement('a');
        viewLink.href = personData.url;
        viewLink.target = '_blank';
        viewLink.rel = 'noopener';
        viewLink.className = 'sp-card-action-btn';
        viewLink.title = 'Edit person';
        viewLink.setAttribute('aria-label', 'Edit ' + personData.name);
        viewLink.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="9.5" y1="3.5" x2="12.5" y2="6.5" stroke="currentColor" stroke-width="1.3"/></svg>';
        actionsRight.appendChild(viewLink);
    }

    // 4. Rebase/center tree button
    if (personData.xref) {
        var rebaseBtn = document.createElement('button');
        rebaseBtn.type = 'button';
        rebaseBtn.className = 'sp-card-action-btn';
        rebaseBtn.title = 'Center tree on this person';
        rebaseBtn.setAttribute('aria-label', 'Center tree on ' + personData.name);
        rebaseBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/><line x1="8" y1="0" x2="8" y2="4" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="12" x2="8" y2="16" stroke="currentColor" stroke-width="1.3"/><line x1="0" y1="8" x2="4" y2="8" stroke="currentColor" stroke-width="1.3"/><line x1="12" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="1.3"/></svg>';
        (function(xref) {
            rebaseBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nav.navigateTo(xref);
            });
        })(personData.xref);
        actionsRight.appendChild(rebaseBtn);
    }

    actions.appendChild(actionsRight);
    card.appendChild(actions);

    return card;
};

/**
 * Create couple-line element with marriage rings, dates, and optional divorce info.
 */
FamilyNavigator.prototype.createCoupleLine = function (familyData, nodeId, familyIndex, familyCount) {
    var nav = this;
    var lineEl = document.createElement('div');
    lineEl.className = 'sp-couple-line';
    lineEl.dataset.familyIndex = familyIndex;
    if (familyData.hasNextRelationship) {
        lineEl.classList.add('sp-couple-has-next');
    }

    // In multi-marriage rows, keep markers compact and move full dates to tooltip.
    var compactMode = (familyCount || 1) > 1;
    if (compactMode) {
        lineEl.classList.add('sp-couple-line-compact');
    }

    // Make the couple-line area clickable → open family page in new tab
    if (familyData.familyUrl) {
        lineEl.style.cursor = 'pointer';
        lineEl.title = 'Open family page';
        lineEl.addEventListener('click', function (e) {
            e.stopPropagation();
            window.open(familyData.familyUrl, '_blank');
        });
    }

    // Hide vertical drop line if this family has no children
    var hasChildren = false;
    var children = this.childrenMap[nodeId];
    if (children) {
        for (var ci = 0; ci < children.length; ci++) {
            var edgeKey = nodeId + '->' + children[ci];
            var edge = this.edgeMap[edgeKey];
            var eFi = (edge && edge.familyIndex !== undefined) ? edge.familyIndex : 0;
            if (eFi === familyIndex) { hasChildren = true; break; }
        }
    }
    if (!hasChildren) {
        lineEl.classList.add('sp-couple-no-children');
    }

    var isDivorced = familyData.divorced || (familyData.spouse && familyData.spouse.divorced);
    var isMarried = familyData.married;

    var tipParts = [];
    if (isDivorced) tipParts.push('Divorced');
    else if (isMarried) tipParts.push('Married');
    else tipParts.push('Partnership');
    if (familyData.marriageDate) tipParts.push('Marriage: ' + familyData.marriageDate);
    if (familyData.divorceDate) tipParts.push('Divorce: ' + familyData.divorceDate);
    if (Number.isFinite(familyData.husbandAgeAtMarriage)) tipParts.push('♂ age at marriage: ' + familyData.husbandAgeAtMarriage);
    if (Number.isFinite(familyData.wifeAgeAtMarriage)) tipParts.push('♀ age at marriage: ' + familyData.wifeAgeAtMarriage);
    if (familyData.marriagePlace) tipParts.push('Marriage place: ' + familyData.marriagePlace);
    if (familyData.divorcePlace) tipParts.push('Divorce place: ' + familyData.divorcePlace);
    if (familyData.durationLabel) tipParts.push('Duration: ' + familyData.durationLabel);
    if (Number.isFinite(familyData.familySourceCount) || Number.isFinite(familyData.familyNoteCount)) {
        tipParts.push('Family sources: ' + (familyData.familySourceCount || 0));
        tipParts.push('Family notes: ' + (familyData.familyNoteCount || 0));
        tipParts.push('Family media: ' + (familyData.familyMediaCount || 0));
    }
    lineEl.title = tipParts.join(' | ');

    var famSourceCount = Number.isFinite(familyData.familySourceCount) ? familyData.familySourceCount : 0;
    var famNoteCount = Number.isFinite(familyData.familyNoteCount) ? familyData.familyNoteCount : 0;
    var famMediaCount = Number.isFinite(familyData.familyMediaCount) ? familyData.familyMediaCount : 0;

    function appendChipExtras(chipEl) {
        var hasExtras = familyData.durationLabel || famSourceCount > 0 || famNoteCount > 0 || famMediaCount > 0;
        if (!hasExtras) return;

        if (familyData.durationLabel) {
            var dur = document.createElement('span');
            dur.className = 'sp-couple-chip-duration';
            dur.textContent = familyData.durationLabel;
            chipEl.appendChild(dur);
        }

        if (famSourceCount > 0 || famNoteCount > 0 || famMediaCount > 0) {
            var iconsRow = document.createElement('span');
            iconsRow.className = 'sp-couple-chip-icons';
            if (!nav.showSources) iconsRow.style.display = 'none';

            var srcIcon = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M2 1h8l4 4v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 1v4h4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
            var noteIconSvg = '<svg viewBox="0 0 16 16" width="10" height="10"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="5" x2="12" y2="5" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="11" x2="9" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>';
            var mediaIconSvg = '<svg viewBox="0 0 16 16" width="10" height="10"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.5" cy="6.5" r="1.5" fill="currentColor"/><path d="M1.5 11l3-3 2 2 3-4 4 5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

            function famIcon(svgHtml, count, label) {
                var wrap = document.createElement('span');
                wrap.className = 'sp-couple-chip-icon';
                if (count > 0) wrap.classList.add('sp-has-data');
                wrap.title = label + ': ' + count;
                wrap.innerHTML = svgHtml;
                if (count > 0) {
                    var badge = document.createElement('span');
                    badge.className = 'sp-action-count';
                    badge.textContent = count;
                    wrap.appendChild(badge);
                }
                return wrap;
            }

            iconsRow.appendChild(famIcon(srcIcon, famSourceCount, 'Sources'));
            iconsRow.appendChild(famIcon(noteIconSvg, famNoteCount, 'Notes'));
            iconsRow.appendChild(famIcon(mediaIconSvg, famMediaCount, 'Media'));
            chipEl.appendChild(iconsRow);
        }
    }

    if (isDivorced) {
        // Divorced layout: top date / broken rings / bottom date.
        lineEl.classList.add('sp-couple-line-divorced');

        if (familyData.marriageDate) {
            var mDate = document.createElement('span');
            mDate.className = 'sp-couple-date sp-couple-date-top';
            var mDateText = document.createElement('span');
            mDateText.className = 'sp-couple-chip-row';
            mDateText.textContent = familyData.marriageDate;
            if (familyData.marriagePlace) {
                var pm = document.createElement('span');
                pm.className = 'sp-place-marker';
                pm.innerHTML = '<svg viewBox="0 0 12 16" width="10" height="13" aria-hidden="true"><path d="M6 0C2.7 0 0 2.5 0 5.6 0 9.8 6 16 6 16s6-6.2 6-10.4C12 2.5 9.3 0 6 0zm0 7.6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="currentColor"/></svg>';
                mDateText.appendChild(pm);
                mDate.title = familyData.marriageDate + ' | ' + familyData.marriagePlace;
            } else {
                mDate.title = familyData.marriageDate;
            }
            mDate.appendChild(mDateText);
            lineEl.appendChild(mDate);
        }

        var brokenRings = document.createElement('span');
        brokenRings.className = 'sp-couple-rings sp-rings-broken';
        brokenRings.innerHTML = '<svg viewBox="0 0 24 14" width="60" height="36"><circle cx="8" cy="7" r="5" fill="' + wtpCSSColors.ringBrokenFill + '" fill-opacity="0.45" stroke="' + wtpCSSColors.ringBrokenStroke + '" stroke-width="1.8"/><circle cx="16" cy="7" r="5" fill="' + wtpCSSColors.ringBrokenFill + '" fill-opacity="0.45" stroke="' + wtpCSSColors.ringBrokenStroke + '" stroke-width="1.8"/><line x1="4" y1="2" x2="20" y2="12" stroke="' + wtpCSSColors.divorceLine + '" stroke-width="1.7"/></svg>';
        lineEl.appendChild(brokenRings);

        {
            var dDate = document.createElement('span');
            dDate.className = 'sp-couple-date sp-couple-date-bottom';
            if (familyData.divorceDate) dDate.classList.add('sp-divorce-date');
            var hasBottomContent = familyData.divorceDate || familyData.durationLabel || famSourceCount > 0 || famNoteCount > 0 || famMediaCount > 0;
            if (hasBottomContent) {
                if (familyData.divorceDate) {
                    var dDateText = document.createElement('span');
                    dDateText.className = 'sp-couple-chip-row';
                    dDateText.textContent = familyData.divorceDate;
                    if (familyData.divorcePlace) {
                        var dpm = document.createElement('span');
                        dpm.className = 'sp-place-marker';
                        dpm.innerHTML = '<svg viewBox="0 0 12 16" width="10" height="13" aria-hidden="true"><path d="M6 0C2.7 0 0 2.5 0 5.6 0 9.8 6 16 6 16s6-6.2 6-10.4C12 2.5 9.3 0 6 0zm0 7.6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="currentColor"/></svg>';
                        dDateText.appendChild(dpm);
                        dDate.title = familyData.divorceDate + ' | ' + familyData.divorcePlace;
                    } else {
                        dDate.title = familyData.divorceDate;
                    }
                    dDate.appendChild(dDateText);
                }
                appendChipExtras(dDate);
                lineEl.appendChild(dDate);
            }
        }
    } else if (isMarried) {
        // Married layout: rings + date chip with duration & icons
        var rings = document.createElement('span');
        rings.className = 'sp-couple-rings';
        rings.innerHTML = '<svg viewBox="0 0 24 14" width="60" height="36"><circle cx="8" cy="7" r="5" fill="' + wtpCSSColors.ringFemaleFill + '" fill-opacity="0.55" stroke="' + wtpCSSColors.ringFemaleStroke + '" stroke-width="1.8"/><circle cx="16" cy="7" r="5" fill="' + wtpCSSColors.ringMaleFill + '" fill-opacity="0.55" stroke="' + wtpCSSColors.ringMaleStroke + '" stroke-width="1.8"/></svg>';
        lineEl.appendChild(rings);
        {
            var hasChipContent = familyData.marriageDate || familyData.durationLabel || famSourceCount > 0 || famNoteCount > 0 || famMediaCount > 0;
            if (hasChipContent) {
                var mDate = document.createElement('span');
                mDate.className = 'sp-couple-date';
                if (familyData.marriageDate) {
                    var mDateText = document.createElement('span');
                    mDateText.className = 'sp-couple-chip-row';
                    mDateText.textContent = familyData.marriageDate;
                    if (familyData.marriagePlace) {
                        var mpm = document.createElement('span');
                        mpm.className = 'sp-place-marker';
                        mpm.innerHTML = '<svg viewBox="0 0 12 16" width="10" height="13" aria-hidden="true"><path d="M6 0C2.7 0 0 2.5 0 5.6 0 9.8 6 16 6 16s6-6.2 6-10.4C12 2.5 9.3 0 6 0zm0 7.6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="currentColor"/></svg>';
                        mDateText.appendChild(mpm);
                        mDate.title = familyData.marriageDate + ' | ' + familyData.marriagePlace;
                    }
                    mDate.appendChild(mDateText);
                }
                appendChipExtras(mDate);
                lineEl.appendChild(mDate);
            }
        }
    } else {
        // Unmarried couple — heart icon, no rings
        var heart = document.createElement('span');
        heart.className = 'sp-couple-rings';
        heart.innerHTML = '<svg viewBox="0 0 20 18" width="48" height="42"><path d="M10 17s-7-4.35-7-10A4 4 0 0 1 10 4a4 4 0 0 1 7 3c0 5.65-7 10-7 10z" fill="' + wtpCSSColors.heartFill + '" fill-opacity="0.72" stroke="' + wtpCSSColors.heartStroke + '" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        lineEl.appendChild(heart);
        {
            var hasExtras = familyData.durationLabel || famSourceCount > 0 || famNoteCount > 0 || famMediaCount > 0;
            if (hasExtras) {
                var uChip = document.createElement('span');
                uChip.className = 'sp-couple-date';
                appendChipExtras(uChip);
                lineEl.appendChild(uChip);
            }
        }
    }

    return lineEl;
};

/**
 * Create a small tree icon button above a person card for ancestor switching.
 * The icon appears above the person whose ancestor line is hidden.
 */
FamilyNavigator.prototype.createAncestorTreeIcon = function (nodeId, lineIndex) {
    var nav = this;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-ancestor-tree-btn';
    btn.title = lineIndex === 0 ? "Show father's ancestors" : "Show mother's / spouse's ancestors";
    btn.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18">'
        + '<line x1="10" y1="20" x2="10" y2="7" stroke="currentColor" stroke-width="2"/>'
        + '<line x1="10" y1="9" x2="4" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        + '<line x1="10" y1="9" x2="16" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        + '<circle cx="4" cy="3" r="2" fill="currentColor"/>'
        + '<circle cx="16" cy="3" r="2" fill="currentColor"/>'
        + '</svg>';
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        nav.switchAncestorLine(nodeId, lineIndex);
    });
    return btn;
};

/**
 * Render ancestor tree icons into the floating overlay (not clipped by viewport).
 */
FamilyNavigator.prototype._renderIconOverlay = function (canvasW, canvasH) {
    if (!this.iconCanvas) return;
    this._syncIconOverlayBounds();
    this.iconCanvas.innerHTML = '';
    this.iconCanvas.style.width = canvasW + 'px';
    this.iconCanvas.style.height = canvasH + 'px';

    var nav = this;
    for (var id in this.cardElements) {
        var el = this.cardElements[id];
        if (!el._ancestorIcons || el._ancestorIcons.length === 0) continue;
        var layout = this.layoutMap[id];
        if (!layout || layout.x === undefined) continue;

        // Find person card and spouse cards within the wrapper
        var cards = el.querySelectorAll('.sp-card');
        for (var ai = 0; ai < el._ancestorIcons.length; ai++) {
            var info = el._ancestorIcons[ai];
            // Determine which card it belongs to
            var targetCard;
            if (info.target === 'person') {
                targetCard = cards[0];
            } else {
                // Spouse card: person card is [0], spouse cards start at [1]
                targetCard = cards[1 + (info.index || 0)];
            }
            if (!targetCard) continue;

            // Position icon above the target card's top-right corner
            var cardLeft = targetCard.offsetLeft + parseFloat(el.style.left);
            var cardTop = targetCard.offsetTop + parseFloat(el.style.top);
            var iconX = cardLeft + targetCard.offsetWidth - 67;
            var iconY = cardTop - 18;

            var cc = wtpCSSColors;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sp-ancestor-expand';
            btn.title = 'Expand ancestors';
            btn.innerHTML = '<svg viewBox="0 0 60 22" width="67" height="17" aria-hidden="true">'
                + '<line x1="30" y1="18" x2="16" y2="12" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
                + '<line x1="30" y1="18" x2="44" y2="12" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
                + '<line x1="16" y1="8" x2="5" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
                + '<line x1="16" y1="8" x2="25" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
                + '<line x1="44" y1="8" x2="35" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
                + '<line x1="44" y1="8" x2="55" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
                + '<circle cx="5" cy="3" r="2.6" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.4"/>'
                + '<circle cx="25" cy="3" r="2.6" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.4"/>'
                + '<circle cx="35" cy="3" r="2.6" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.4"/>'
                + '<circle cx="55" cy="3" r="2.6" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.4"/>'
                + '<circle cx="16" cy="10" r="3" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.6"/>'
                + '<circle cx="44" cy="10" r="3" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.6"/>'
                + '<circle cx="30" cy="19" r="3" fill="' + cc.connectorLine + '" fill-opacity="0.35" stroke="' + cc.connectorLine + '" stroke-width="1.8"/>'
                + '</svg>';
            btn.style.position = 'absolute';
            btn.style.left = iconX + 'px';
            btn.style.top = iconY + 'px';
            (function(iconInfo, nodeId) {
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (iconInfo.familyXref) {
                        nav.expandAncestorInPlace(nodeId, iconInfo.familyXref, iconInfo.childXref, iconInfo.lineIndex);
                    } else {
                        nav.navigateTo(iconInfo.xref);
                    }
                });
            })(info, id);
            this.iconCanvas.appendChild(btn);
        }
    }
};

/**
 * Create a navigation icon — click to re-center the tree on this person.
 * (Legacy — no longer appended to cards, icons are in the overlay layer.)
 */
FamilyNavigator.prototype.createNavigateIcon = function (xref) {
    var nav = this;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-ancestor-tree-btn sp-ancestor-expand';
    btn.title = 'Navigate to ancestors';
    var cc = wtpCSSColors;
    btn.innerHTML = '<svg viewBox="0 0 60 22" width="67" height="17" aria-hidden="true">'
        + '<line x1="30" y1="18" x2="16" y2="12" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
        + '<line x1="30" y1="18" x2="44" y2="12" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
        + '<line x1="16" y1="8" x2="5" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
        + '<line x1="16" y1="8" x2="25" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
        + '<line x1="44" y1="8" x2="35" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
        + '<line x1="44" y1="8" x2="55" y2="4" stroke="' + cc.connectorLine + '" stroke-width="1.4" stroke-linecap="round"/>'
        + '<circle cx="5" cy="3" r="2.6" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.4"/>'
        + '<circle cx="25" cy="3" r="2.6" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.4"/>'
        + '<circle cx="35" cy="3" r="2.6" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.4"/>'
        + '<circle cx="55" cy="3" r="2.6" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.4"/>'
        + '<circle cx="16" cy="10" r="3" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.6"/>'
        + '<circle cx="44" cy="10" r="3" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.6"/>'
        + '<circle cx="30" cy="19" r="3" fill="' + cc.connectorLine + '" fill-opacity="0.35" stroke="' + cc.connectorLine + '" stroke-width="1.8"/>'
        + '</svg>';
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        nav.navigateTo(xref);
    });
    return btn;
};

/**
 * Create a lazy-load placeholder element.
 */
FamilyNavigator.prototype.createLazyElement = function (node, layout) {
    var el = document.createElement('div');
    el.className = 'sp-lazy-placeholder';
    el.style.position = 'absolute';
    el.style.left = layout.x + 'px';
    el.style.top = layout.y + 'px';
    el.style.width = this.LAZY_W + 'px';
    el.style.height = this.LAZY_H + 'px';
    el.dataset.nodeId = node.id;
    el.dataset.familyXref = node.familyXref;
    el.textContent = '+ expand';

    var nav = this;
    el.addEventListener('click', function () {
        nav.expandLazyNode(node.id);
    });

    return el;
};

// ==========================================================================
// GEOMETRY HELPERS — Pure calculations (no DOM measurements)
// ==========================================================================

/**
 * Get person card right edge X
 */
FamilyNavigator.prototype.getPersonRightX = function(layout) {
    return layout.x + this.CARD_W;
};

/**
 * Get person card vertical center Y
 */
FamilyNavigator.prototype.getPersonCenterY = function(layout) {
    // Use standard card height to ensure ALL siblings in same generation
    // have connectors at EXACTLY same Y, regardless of actual measured height
    return layout.y + (this.CARD_H / 2);
};

/**
 * Get person card bottom Y
 */
FamilyNavigator.prototype.getPersonBottomY = function(layout) {
    // Use measured height for child connector source since children
    // are aligned by _alignChildRow() to account for height differences
    return layout.y + layout.h;
};

/**
 * Get spouse card left X for given spouse index
 */
FamilyNavigator.prototype.getSpouseLeftX = function(layout, spouseIndex) {
    return layout.x + this.CARD_W + this.COUPLE_GAP + spouseIndex * (this.CARD_W + this.COUPLE_GAP);
};

/**
 * Get couple-line center X for given family index
 */
FamilyNavigator.prototype.getCoupleLineCenterX = function(layout, familyIndex) {
    var personRight = this.getPersonRightX(layout);
    var spouseLeft = this.getSpouseLeftX(layout, familyIndex);
    return (personRight + spouseLeft) / 2;
};

// ==========================================================================
// CANVAS CONNECTORS — draw on <canvas> element behind cards
// ==========================================================================

FamilyNavigator.prototype.drawConnectors = function (canvasW, canvasH) {
    var cvs = this.connCanvas;
    if (!cvs) return;

    var dpr = window.devicePixelRatio || 1;

    // Cap canvas to browser max size (typically 16384px per dimension)
    var maxCanvasDim = 16384;
    var effectiveW = canvasW;
    var effectiveH = canvasH;
    if (effectiveW * dpr > maxCanvasDim || effectiveH * dpr > maxCanvasDim) {
        dpr = Math.min(dpr, maxCanvasDim / Math.max(effectiveW, effectiveH));
    }

    cvs.width = Math.floor(effectiveW * dpr);
    cvs.height = Math.floor(effectiveH * dpr);
    cvs.style.width = canvasW + 'px';
    cvs.style.height = canvasH + 'px';

    var ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Use theme-portable color from CSS token
    var connectorColor = wtpCSSColors.connectorLine;
    
    ctx.strokeStyle = connectorColor;
    ctx.fillStyle = connectorColor;
    var desiredLineWidth = 2;
    var lineWidthDev = Math.max(1, Math.round(desiredLineWidth * dpr));
    ctx.lineWidth = lineWidthDev / dpr;
    // For odd device-pixel widths, center lines on half-pixels; for even widths, on integers.
    var snapOffsetDev = (lineWidthDev % 2 === 1) ? 0.5 : 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Use butt caps so line ends don't protrude past endpoints.
    // Rounded appearance is provided by joins and explicit endpoint dots.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    var R = 8; // corner radius for rounded connectors
    var dotRadius = 4; // Small circle radius at connection points
    var self = this;
    function snap(v) { return (Math.round(v * dpr) + snapOffsetDev) / dpr; }

    // Helper to draw a small filled circle
    function drawDot(x, y) {
        x = snap(x);
        y = snap(y);
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // ====================================================================================
    // PARTNER/SPOUSE CONNECTORS — Horizontal lines at card vertical center
    // ====================================================================================
    // Track staggered Y offsets for each family so child forks can originate from correct position
    var staggeredOffsets = {};  // nodeId -> { familyIndex -> yOffset }
    
    for (var nodeId in this.layoutMap) {
        var layout = this.layoutMap[nodeId];
        if (!layout || layout.x === undefined) continue;
        
        var node = this.nodeMap[nodeId];
        if (!node || !node.families || node.families.length === 0) continue;
        
        var wrapper = this.cardElements[nodeId];
        if (!wrapper) continue;
        
        var wrapperRect = wrapper.getBoundingClientRect();
        var coupleLines = wrapper.querySelectorAll('.sp-couple-line');
        var allCards = wrapper.querySelectorAll('.sp-card');
        
        // Get person card (first card)
        var personCard = allCards[0];
        if (!personCard) continue;
        
        var personCardRect = personCard.getBoundingClientRect();
        // Person's right edge X coordinate
        var personRightX = snap(layout.x + (personCardRect.right - wrapperRect.left) / this.zoomLevel);
        
        // Stagger divorce connectors vertically - each spouse at different Y level
        // Spread up to 5 spouses across wider vertical range for better visual separation
        var familyCount = coupleLines.length;
        var verticalSpacing = familyCount > 1 ? 16 : 0;  // pixels between each spouse connector (increased for better visibility)
        var centerY = this.getPersonCenterY(layout);
        
        // Store offsets for this node's families
        staggeredOffsets[nodeId] = {};
        
        // Draw connector for each family (person to each spouse)
        for (var fi = 0; fi < coupleLines.length; fi++) {
            // Stagger Y position: center ± offset based on family index
            var offset = (fi - (familyCount - 1) / 2) * verticalSpacing;
            var connectorY = snap(centerY + offset);
            
            // Store offset for child fork drawing
            staggeredOffsets[nodeId][fi] = offset;
            
            // Keep couple drops rendered on canvas for consistent connector color.
            var lineEl = coupleLines[fi];
            if (lineEl) {
                lineEl.classList.add('sp-couple-line-staggered');
            }
            
            // Spouse card is at allCards index (fi + 1)
            var spouseCard = allCards[fi + 1];
            if (!spouseCard) continue;
            
            var spouseCardRect = spouseCard.getBoundingClientRect();
            // Spouse's left edge X coordinate
            var spouseLeftX = snap(layout.x + (spouseCardRect.left - wrapperRect.left) / this.zoomLevel);
            
            // Endpoints exactly on card borders (dots are centered here).
            var lineStartX = personRightX;
            var lineEndX = spouseLeftX;
            
            // Draw straight horizontal connector between person and spouse
            ctx.beginPath();
            ctx.moveTo(lineStartX, connectorY);
            ctx.lineTo(lineEndX, connectorY);
            ctx.stroke();
            
            // Draw anchor dots centered on card borders (half-hidden by cards)
            drawDot(personRightX, connectorY);
            drawDot(spouseLeftX, connectorY);
            
            // Draw vertical couple drop on canvas for all families.
            // Skip families marked with no children.
            if (lineEl && !lineEl.classList.contains('sp-couple-no-children')) {
                var lineRect = lineEl.getBoundingClientRect();
                var dropStartY = snap(connectorY - 1);
                var dropEndY = snap(layout.y + ((lineRect.bottom - wrapperRect.top) / this.zoomLevel) + offset);
                var dropX = snap(layout.x + ((lineRect.left + lineRect.width / 2) - wrapperRect.left) / this.zoomLevel);

                ctx.beginPath();
                ctx.moveTo(dropX, dropStartY);
                ctx.lineTo(dropX, dropEndY);
                ctx.stroke();
            }
        }
    }

    // Draw edges between parent and child nodes
    for (var parentId in this.childrenMap) {
        var children = this.getVisibleChildren(parentId);
        if (children.length === 0) continue;

        var pLayout = this.layoutMap[parentId];
        if (!pLayout || pLayout.x === undefined) continue;

        var pNode = this.nodeMap[parentId];
        var srcY = pLayout.y + pLayout.h;

        // Helper functions for connector source and target positions
        var self = this;
        
        function coupleLineCenterX(nodeId, layout, fi) {
            var wrapper = self.cardElements[nodeId];
            if (wrapper) {
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                if (lines[fi]) {
                    var wRect = wrapper.getBoundingClientRect();
                    var lineRect = lines[fi].getBoundingClientRect();
                    return layout.x + ((lineRect.left + lineRect.width / 2) - wRect.left) / self.zoomLevel;
                }
            }
            return self.getCoupleLineCenterX(layout, fi);
        }

        function coupleLineBottomY(nodeId, layout, fi) {
            var wrapper = self.cardElements[nodeId];
            if (wrapper) {
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                if (lines[fi]) {
                    var wRect = wrapper.getBoundingClientRect();
                    var lineRect = lines[fi].getBoundingClientRect();
                    return layout.y + ((lineRect.bottom - wRect.top) / self.zoomLevel);
                }
            }
            return self.getPersonBottomY(layout);
        }

        // Group children by familyIndex (undefined = ancestor or no-family edges)
        var familyGroups = {};
        var defaultGroup = [];
        
        for (var ci = 0; ci < children.length; ci++) {
            var childId = children[ci];
            var edgeKey = parentId + '->' + childId;
            var edge = this.edgeMap[edgeKey];
            if (edge && edge.familyIndex !== undefined) {
                var fi = edge.familyIndex;
                if (!familyGroups[fi]) familyGroups[fi] = [];
                familyGroups[fi].push({ childId: childId, edge: edge });
            } else {
                defaultGroup.push({ childId: childId, edge: edge });
            }
        }

        // CRITICAL: Collect all target Y values first to find global minimum
        // This ensures siblings connect at same Y even if in different groups
        function targetXForChild(childId, edge) {
            var cLayout = self.layoutMap[childId];
            if (!cLayout || cLayout.x === undefined) return null;
            
            var childNode = self.nodeMap[childId];
            var tx = cLayout.centerX;  // Default: wrapper center
            var ty = cLayout.y;        // Card top border (dot appears half-hidden behind card)
            
            // If child has families, target specific card (person or spouse)
            if (childNode && childNode.families && childNode.families.length > 0) {
                var wrapper = self.cardElements[childId];
                if (wrapper) {
                    var wRect = wrapper.getBoundingClientRect();
                    var cards = wrapper.querySelectorAll('.sp-card');
                    
                    if (edge && edge.lineIndex !== undefined) {
                        // Explicit line index: 0 = person card, 1 = first spouse card
                        var targetCard = cards[edge.lineIndex === 1 ? 1 : 0];
                        if (targetCard) {
                            var cardRect = targetCard.getBoundingClientRect();
                            tx = cLayout.x + ((cardRect.left + cardRect.width / 2) - wRect.left) / self.zoomLevel;
                        }
                    } else {
                        // Implicit: check originalChildXref to determine target
                        var oxref = childNode.originalChildXref;
                        var cFirstSpouse = childNode.families[0].spouse;
                        var targetCard = cards[0]; // Default to person card
                        if (oxref && cFirstSpouse && cFirstSpouse.xref === oxref && cards[1]) {
                            targetCard = cards[1]; // Use spouse card
                        }
                        if (targetCard) {
                            var cardRect = targetCard.getBoundingClientRect();
                            tx = cLayout.x + ((cardRect.left + cardRect.width / 2) - wRect.left) / self.zoomLevel;
                        }
                    }
                }
            }
            return { x: tx, y: ty };
        }
        
        // Collect all targets and find minimum Y across ALL children
        var minGlobalY = Infinity;
        for (var ci = 0; ci < children.length; ci++) {
            var childId = children[ci];
            var edgeKey = parentId + '->' + childId;
            var edge = this.edgeMap[edgeKey];
            var t = targetXForChild(childId, edge);
            if (t && t.y < minGlobalY) {
                minGlobalY = t.y;
            }
        }

        // Draw forks per family group — stagger bar heights so they don't overlap
        var familyKeys = Object.keys(familyGroups).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
        var familyGroupCount = familyKeys.length;
        var primaryFamilyIndex = familyGroupCount > 0 ? familyKeys[0] : -1;
        for (var fki = 0; fki < familyKeys.length; fki++) {
            var fi = familyKeys[fki];
            var items = familyGroups[fi];
            var srcX = coupleLineCenterX(parentId, pLayout, fi);
            var famSrcY = coupleLineBottomY(parentId, pLayout, fi) + this.FORK_SOURCE_OFFSET;
            
            // Add staggered offset from spouse connectors so forks originate from staggered positions
            if (staggeredOffsets[parentId] && staggeredOffsets[parentId][fi] !== undefined) {
                famSrcY += staggeredOffsets[parentId][fi];
            }
            
            var targets = [];
            for (var gi = 0; gi < items.length; gi++) {
                var t = targetXForChild(items[gi].childId, items[gi].edge);
                if (t) {
                    t.y = minGlobalY; // Force all siblings to same Y
                    targets.push(t);
                }
            }
            if (targets.length > 0) {
                // Keep primary family branch at baseline level; offset later families only.
                var barRatio = 0.5;
                if (familyGroupCount > 1 && fi !== primaryFamilyIndex) {
                    var offsetIdx = Math.max(0, fki - 1);
                    // Move secondary families upward from the baseline branch.
                    barRatio = Math.max(0.16, 0.30 - offsetIdx * 0.08);
                }
                this.drawFork(ctx, srcX, famSrcY, targets, R, barRatio, dpr, snapOffsetDev);
            }
        }

        // Draw default group (ancestor edges, etc.) from first couple-line center or card center
        if (defaultGroup.length > 0) {
            var defSrcX;
            var defSrcY;
            if (pNode && pNode.families && pNode.families.length > 0) {
                defSrcX = coupleLineCenterX(parentId, pLayout, 0);
                defSrcY = coupleLineBottomY(parentId, pLayout, 0) + this.FORK_SOURCE_OFFSET;
                
                // Add staggered offset from first spouse connector
                if (staggeredOffsets[parentId] && staggeredOffsets[parentId][0] !== undefined) {
                    defSrcY += staggeredOffsets[parentId][0];
                }
            } else {
                defSrcX = pLayout.centerX;
                defSrcY = srcY;
            }
            var targets = [];
            for (var gi = 0; gi < defaultGroup.length; gi++) {
                var t = targetXForChild(defaultGroup[gi].childId, defaultGroup[gi].edge);
                if (t) {
                    t.y = minGlobalY; // Force all siblings to same Y
                    targets.push(t);
                }
            }
            if (targets.length > 0) {
                this.drawFork(ctx, defSrcX, defSrcY, targets, R, undefined, dpr, snapOffsetDev);
            }
        }
    }
};

/**
 * Draw a fork connector: one source at top, branching down to multiple targets.
 * Uses rounded corners for a polished look.
 */
FamilyNavigator.prototype.drawFork = function (ctx, srcX, srcY, targets, R, barYRatio, dpr, snapOffsetDev) {
    if (targets.length === 0) return;
    if (barYRatio === undefined) barYRatio = 0.5;

    var dotRadius = 4; // Small circle radius at connection points
    if (!dpr || dpr <= 0) dpr = window.devicePixelRatio || 1;
    if (snapOffsetDev === undefined) {
        var lineWidthDev = Math.max(1, Math.round(ctx.lineWidth * dpr));
        snapOffsetDev = (lineWidthDev % 2 === 1) ? 0.5 : 0;
    }
    function snap(v) { return (Math.round(v * dpr) + snapOffsetDev) / dpr; }
    srcX = snap(srcX);
    srcY = snap(srcY);

    // Bar Y = positioned between source bottom and nearest target top
    var nearestY = targets[0].y;
    for (var i = 1; i < targets.length; i++) {
        if (targets[i].y < nearestY) nearestY = targets[i].y;
    }

    // Keep sibling bars aligned by anchoring barY to the child row,
    // then apply a small family-group stagger to avoid vertical overlap
    // between different marriage branches.
    var preferredGapFromTarget = 22;
    var minGapFromSource = 10;
    var minGapFromTarget = 8;

    // barYRatio is provided by caller per family-group (0.2..0.8).
    // Map it to a small vertical offset around the aligned baseline.
    var groupYOffset = 0;
    if (barYRatio !== undefined) {
        groupYOffset = Math.round((barYRatio - 0.5) * 36);
    }

    var barY = nearestY - preferredGapFromTarget + groupYOffset;
    var minBarY = srcY + minGapFromSource;
    var maxBarY = nearestY - minGapFromTarget;

    if (barY < minBarY) barY = minBarY;
    if (barY > maxBarY) barY = maxBarY;

    // Tight-space fallback (source and target nearly touching)
    if (minBarY > maxBarY) {
        barY = nearestY - 2;
        if (barY < srcY + 3) barY = srcY + 3;
    }

    barY = snap(barY);

    // Helper: draw a small filled circle
    function drawDot(x, y) {
        x = snap(x);
        y = snap(y);
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Single child directly below — straight line
    if (targets.length === 1 && Math.abs(targets[0].x - srcX) < 2) {
        ctx.beginPath();
        ctx.moveTo(srcX, srcY);
        ctx.lineTo(srcX, targets[0].y - dotRadius);
        ctx.stroke();
        drawDot(srcX, targets[0].y);
        return;
    }

    // Single child offset — L-shape with rounded corners (arcTo for consistency)
    if (targets.length === 1) {
        var tx = snap(targets[0].x);
        var ty = snap(targets[0].y);
        var dir = tx > srcX ? 1 : -1;
        var r = Math.min(R, Math.abs(tx - srcX) / 2, Math.abs(barY - srcY), Math.abs(ty - barY));
        if (Math.abs(tx - srcX) > 3 && Math.abs(barY - srcY) > 6 && Math.abs(ty - barY) > 6) {
            r = Math.max(3, r);
        }

        ctx.beginPath();
        ctx.moveTo(srcX, srcY);

        if (r >= 1) {
            // Corner 1: vertical trunk -> horizontal bar
            ctx.lineTo(srcX, barY - r);
            ctx.arcTo(srcX, barY, srcX + dir * r, barY, r);

            // Corner 2: horizontal bar -> vertical drop
            ctx.lineTo(tx - dir * r, barY);
            ctx.arcTo(tx, barY, tx, barY + r, r);
        } else {
            ctx.lineTo(srcX, barY);
            ctx.lineTo(tx, barY);
        }

        // Final vertical segment ends at top edge of endpoint dot
        ctx.lineTo(tx, ty - dotRadius);
        ctx.stroke();
        drawDot(tx, ty);
        return;
    }

    // Multiple children — draw one shared fork (trunk + bar + drops).
    // This avoids re-drawing overlapping paths for each child, which can
    // look like "spaghetti" on dense trees with multiple families.
    targets.sort(function (a, b) { return a.x - b.x; });
    var minX = Infinity;
    var maxX = -Infinity;

    // Compute where each drop/elbow actually starts on the bar, so the bar
    // doesn't extend past rounded corners and create a "too long" look.
    for (var bi = 0; bi < targets.length; bi++) {
        var btx = snap(targets[bi].x);
        var bty = snap(targets[bi].y);
        var bdx = btx - srcX;
        var bdir = bdx > 0 ? 1 : (bdx < 0 ? -1 : 0);
        var br = Math.min(R, Math.abs(bdx), Math.abs(bty - barY));
        if (Math.abs(bdx) > 3 && Math.abs(bty - barY) > 5) {
            br = Math.max(2, br);
        }
        var barAttachX = (bdir === 0 || br < 1) ? btx : (btx - bdir * br);

        if (barAttachX < minX) minX = barAttachX;
        if (barAttachX > maxX) maxX = barAttachX;
    }

    // Ensure horizontal bar always intersects the source trunk.
    if (srcX < minX) minX = srcX;
    if (srcX > maxX) maxX = srcX;

    // Tiny overlap at joins helps avoid anti-aliased gaps when zoomed out.
    var joinOverlap = 1;

    // Draw trunk + bar with rounded elbow for one-sided forks
    var hasLeft = minX < srcX;
    var hasRight = maxX > srcX;
    var joinR = Math.min(R, 6, Math.abs(barY - srcY));

    ctx.beginPath();
    ctx.moveTo(srcX, srcY);

    if (hasLeft && !hasRight && joinR >= 1) {
        // Only left branch: rounded corner from trunk to left bar
        ctx.lineTo(srcX, barY - joinR);
        ctx.arcTo(srcX, barY, srcX - joinR, barY, joinR);
        ctx.lineTo(minX, barY);
    } else if (hasRight && !hasLeft && joinR >= 1) {
        // Only right branch: rounded corner from trunk to right bar
        ctx.lineTo(srcX, barY - joinR);
        ctx.arcTo(srcX, barY, srcX + joinR, barY, joinR);
        ctx.lineTo(maxX, barY);
    } else {
        // T-junction (or tiny space): keep centered trunk with bar sections
        ctx.lineTo(srcX, barY + joinOverlap);
        if (hasLeft) {
            ctx.moveTo(minX, barY);
            ctx.lineTo(srcX + joinOverlap, barY);
        }
        if (hasRight) {
            if (!hasLeft) {
                ctx.moveTo(srcX, barY);
            }
            ctx.lineTo(maxX, barY);
        }
    }

    ctx.stroke();

    // Individual drops to each child with same rounded elbow style.
    for (var i = 0; i < targets.length; i++) {
        var tx = snap(targets[i].x);
        var ty = snap(targets[i].y);
        var dx = tx - srcX;
        var dir = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
        var r = Math.min(R, Math.abs(dx), Math.abs(ty - barY));
        if (Math.abs(dx) > 3 && Math.abs(ty - barY) > 6) {
            r = Math.max(3, r);
        }

        // Directly below trunk: straight drop
        if (dir === 0 || r < 1) {
            ctx.beginPath();
            ctx.moveTo(tx, barY - joinOverlap);
            ctx.lineTo(tx, ty - dotRadius);
            ctx.stroke();
        } else {
            // Rounded elbow from bar into drop for consistent appearance
            ctx.beginPath();
            ctx.moveTo(tx - dir * r - dir * joinOverlap, barY);
            ctx.arcTo(tx, barY, tx, barY + r, r);
            ctx.lineTo(tx, ty - dotRadius);
            ctx.stroke();
        }

        drawDot(tx, ty);
    }
};

// ==========================================================================
// ANCESTOR LINE SWITCHING
// ==========================================================================

FamilyNavigator.prototype.switchAncestorLine = function (nodeId, lineIndex) {
    this.activeLines[nodeId] = lineIndex;
    this.measureAndRender();
    this.focusNode(nodeId);
};

/**
 * Load ancestors for a node that doesn't have them yet.
 * Navigates to the person, reloading the entire tree centered on them.
 */
FamilyNavigator.prototype.expandAncestors = function (nodeId, ancestorLine) {
    var xref = ancestorLine.spouseXref || ancestorLine.personXref || '';
    if (!xref) return;
    this.navigateTo(xref);
};

/**
 * Expand ancestor branch in-place — fetch and merge ancestor data
 * without rebasing the whole tree.
 */
FamilyNavigator.prototype.expandAncestorInPlace = function (childNodeId, familyXref, childXref, lineIndex) {
    var nav = this;

    // If ancestors for this line are already loaded (but hidden), just switch to them
    var existingEdges = this.parentEdges[childNodeId] || [];
    for (var i = 0; i < existingEdges.length; i++) {
        if (existingEdges[i].lineIndex === lineIndex) {
            this.activeLines[childNodeId] = lineIndex;
            this.measureAndRender();
            this.focusNode(childNodeId);
            return;
        }
    }

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(familyXref)
        + '&pid=' + encodeURIComponent(childXref);

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        nav._mergeAncestorData(childNodeId, newData, lineIndex);
                    }
                } catch (e) {
                    console.error('SP Tree Navigator: ancestor expand parse error', e);
                }
            }
        }
    };
    xhr.send();
};

/**
 * Merge fetched ancestor data into the existing tree, connecting
 * the new subtree root to the given child node.
 */
FamilyNavigator.prototype._mergeAncestorData = function (childNodeId, newData, lineIndex) {
    // Add new nodes
    for (var i = 0; i < newData.nodes.length; i++) {
        var n = newData.nodes[i];
        this.nodeMap[n.id] = n;
    }

    // Add new edges
    for (var i = 0; i < newData.edges.length; i++) {
        var edge = newData.edges[i];
        var key = edge.from + '->' + edge.to;
        this.edgeMap[key] = edge;

        if (!this.childrenMap[edge.from]) {
            this.childrenMap[edge.from] = [];
        }
        this.childrenMap[edge.from].push(edge.to);

        if (!this.parentEdges[edge.to]) {
            this.parentEdges[edge.to] = [];
        }
        this.parentEdges[edge.to].push(edge);
    }

    // Connect the new subtree root to the existing child node
    if (newData.rootId) {
        var connectEdge = {
            from: newData.rootId,
            to: childNodeId,
            type: 'parent-child',
            line: lineIndex === 0 ? 'self' : 'spouse',
            lineIndex: lineIndex
        };
        var connectKey = newData.rootId + '->' + childNodeId;
        this.edgeMap[connectKey] = connectEdge;

        if (!this.childrenMap[newData.rootId]) this.childrenMap[newData.rootId] = [];
        this.childrenMap[newData.rootId].push(childNodeId);

        if (!this.parentEdges[childNodeId]) this.parentEdges[childNodeId] = [];
        this.parentEdges[childNodeId].push(connectEdge);
    }

    // Switch to the newly expanded ancestor line so it becomes visible
    if (lineIndex > 0) {
        this.activeLines[childNodeId] = lineIndex;
    }

    // Re-measure and re-render, then scroll to the expanded area
    this.measureAndRender();
    this.focusNode(childNodeId);
};

/**
 * Navigate to a new person — reload the entire tree centered on them.
 * This is the primary navigation mechanism for exploring large genealogies.
 */
FamilyNavigator.prototype.navigateTo = function (xref) {
    var nav = this;

    var url = this.expandUrl
        .replace('action=NodeExpand', 'action=NavigateTo')
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&xref=' + encodeURIComponent(xref);

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        // Replace the entire tree
                        nav.treeData = newData;
                        nav.activeLines = {};

                        nav.buildIndex(newData);
                        nav._setCurrentXref(xref);
                        nav.measureAndRender();
                        nav.focusOrigin();
                        nav._updateFocusPersonBox();
                    }
                } catch (e) {
                    console.error('SP Tree Navigator: navigate parse error', e);
                }
            }
        }
    };
    xhr.send();
};

// ==========================================================================
// LAZY EXPANSION — AJAX load subtree
// ==========================================================================

FamilyNavigator.prototype.expandLazyNode = function (lazyNodeId) {
    var nav = this;
    var node = this.nodeMap[lazyNodeId];
    if (!node || node.type !== 'lazy') return;

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(node.familyXref)
        + '&pid=' + encodeURIComponent(node.childXref || node.familyXref);

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        nav.mergeLazyData(lazyNodeId, newData);
                    } else {
                        // Empty response — remove the lazy node silently
                        delete nav.nodeMap[lazyNodeId];
                        nav.measureAndRender();
                    }
                } catch (e) {
                    console.error('SP Tree Navigator: expand parse error', e);
                    delete nav.nodeMap[lazyNodeId];
                    nav.measureAndRender();
                }
            } else {
                // HTTP error — remove the lazy node
                delete nav.nodeMap[lazyNodeId];
                nav.measureAndRender();
            }
        }
    };
    xhr.send();
};

/**
 * Merge newly loaded subtree data, replacing the lazy placeholder.
 */
FamilyNavigator.prototype.mergeLazyData = function (lazyNodeId, newData) {
    var lazyNode = this.nodeMap[lazyNodeId];
    var lazyDirection = lazyNode ? lazyNode.direction : 'up';

    // Find the edge that connects to this lazy node
    var lazyParentEdges = this.parentEdges[lazyNodeId] || [];
    var parentId = lazyParentEdges.length > 0 ? lazyParentEdges[0].from : null;
    var oldEdge = lazyParentEdges.length > 0 ? lazyParentEdges[0] : null;

    // For descendant lazy nodes, the lazy node is a child — find parent via childrenMap
    if (!parentId && lazyDirection === 'down') {
        for (var pid in this.childrenMap) {
            var idx = this.childrenMap[pid].indexOf(lazyNodeId);
            if (idx >= 0) {
                parentId = pid;
                var ek = pid + '->' + lazyNodeId;
                oldEdge = this.edgeMap[ek] || null;
                break;
            }
        }
    }

    // For ancestor lazy nodes, the lazy IS the parent — find child via childrenMap
    var childId = null;
    if (lazyDirection === 'up' && this.childrenMap[lazyNodeId] && this.childrenMap[lazyNodeId].length > 0) {
        childId = this.childrenMap[lazyNodeId][0];
        var ek = lazyNodeId + '->' + childId;
        oldEdge = this.edgeMap[ek] || null;
        // For ancestor lazy, "parentId" is actually the child the new root should connect TO
        parentId = childId;
    }

    // Remove the lazy node
    delete this.nodeMap[lazyNodeId];
    delete this.layoutMap[lazyNodeId];

    // Remove old edge(s)
    if (parentId) {
        var edgeKey = parentId + '->' + lazyNodeId;
        delete this.edgeMap[edgeKey];
        var edgeKey2 = lazyNodeId + '->' + parentId;
        delete this.edgeMap[edgeKey2];
        // Clean childrenMap in both directions
        var cidx = this.childrenMap[parentId] ? this.childrenMap[parentId].indexOf(lazyNodeId) : -1;
        if (cidx >= 0) this.childrenMap[parentId].splice(cidx, 1);
        delete this.childrenMap[lazyNodeId];
        delete this.parentEdges[lazyNodeId];
        // Clean parentEdges on the connected node
        if (this.parentEdges[parentId]) {
            this.parentEdges[parentId] = this.parentEdges[parentId].filter(function (e) {
                return e.from !== lazyNodeId;
            });
        }
    }

    // Add new nodes
    for (var i = 0; i < newData.nodes.length; i++) {
        var n = newData.nodes[i];
        this.nodeMap[n.id] = n;
    }

    // Add new edges
    for (var i = 0; i < newData.edges.length; i++) {
        var edge = newData.edges[i];
        var key = edge.from + '->' + edge.to;
        this.edgeMap[key] = edge;

        if (!this.childrenMap[edge.from]) {
            this.childrenMap[edge.from] = [];
        }
        this.childrenMap[edge.from].push(edge.to);

        if (!this.parentEdges[edge.to]) {
            this.parentEdges[edge.to] = [];
        }
        this.parentEdges[edge.to].push(edge);
    }

    // Connect the new subtree root to the existing tree
    if (parentId && newData.rootId) {
        var newEdge;
        if (lazyDirection === 'down') {
            // Descendant lazy: parent -> newRoot (newRoot is a child of parent)
            newEdge = {
                from: parentId,
                to: newData.rootId,
                type: 'parent-child'
            };
            var newKey = parentId + '->' + newData.rootId;
            this.edgeMap[newKey] = newEdge;
            if (!this.childrenMap[parentId]) this.childrenMap[parentId] = [];
            this.childrenMap[parentId].push(newData.rootId);
            if (!this.parentEdges[newData.rootId]) this.parentEdges[newData.rootId] = [];
            this.parentEdges[newData.rootId].push(newEdge);
        } else {
            // Ancestor lazy: newRoot -> parent (newRoot is an ancestor of parent)
            newEdge = {
                from: newData.rootId,
                to: parentId,
                type: 'parent-child'
            };
            // Preserve lineIndex from old edge
            if (oldEdge && oldEdge.lineIndex !== undefined) {
                newEdge.lineIndex = oldEdge.lineIndex;
                newEdge.line = oldEdge.line;
            }
            var newKey = newData.rootId + '->' + parentId;
            this.edgeMap[newKey] = newEdge;
            if (!this.childrenMap[newData.rootId]) this.childrenMap[newData.rootId] = [];
            this.childrenMap[newData.rootId].push(parentId);
            if (!this.parentEdges[parentId]) this.parentEdges[parentId] = [];
            this.parentEdges[parentId].push(newEdge);
        }
    }

    // Re-measure and re-render, then center on the connected node
    this.measureAndRender();
    this.focusNode(parentId || newData.rootId);
};

// ==========================================================================
// PAN & ZOOM
// ==========================================================================

FamilyNavigator.prototype.initPanZoom = function () {
    var nav = this;
    if (!this.container) return;

    var dragging = false;
    var isDown = false;
    var startX, startY;
    var startPanX, startPanY;

    this.container.addEventListener('mousedown', function (e) {
        if (e.target.closest('.sp-card') || e.target.closest('.sp-ancestor-tree-btn') || e.target.closest('.sp-lazy-placeholder') || e.target.closest('.sp-btn') || e.target.closest('a')) return;
        isDown = true;
        dragging = false;
        startX = e.clientX;
        startY = e.clientY;
        startPanX = nav.panX;
        startPanY = nav.panY;
        nav.container.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', function (e) {
        if (!isDown) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging = true;
        if (!dragging) return;
        e.preventDefault();
        nav.panX = startPanX + dx;
        nav.panY = startPanY + dy;
        nav.applyTransform();
    });

    document.addEventListener('mouseup', function (e) {
        if (dragging) e.preventDefault();
        isDown = false;
        dragging = false;
        if (nav.container) nav.container.style.cursor = '';
    });

    // Touch support
    this.container.addEventListener('touchstart', function (e) {
        if (e.target.closest('.sp-card') || e.target.closest('.sp-ancestor-tree-btn') || e.target.closest('.sp-lazy-placeholder') || e.target.closest('.sp-btn') || e.target.closest('a')) return;
        if (e.touches.length !== 1) return;
        isDown = true;
        dragging = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startPanX = nav.panX;
        startPanY = nav.panY;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
        if (!isDown || e.touches.length !== 1) return;
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging = true;
        if (!dragging) return;
        nav.panX = startPanX + dx;
        nav.panY = startPanY + dy;
        nav.applyTransform();
    }, { passive: true });

    document.addEventListener('touchend', function () {
        isDown = false;
        dragging = false;
    });

    // Wheel zoom
    this.container.addEventListener('wheel', function (e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? nav.zoomStep : -nav.zoomStep;
        var newZoom = Math.min(nav.zoomMax, Math.max(nav.zoomMin, nav.zoomLevel + delta));
        newZoom = Math.round(newZoom * 100) / 100;

        if (newZoom === nav.zoomLevel) return;

        // Zoom towards cursor position
        var wrapRect = nav.container.getBoundingClientRect();
        var mouseX = e.clientX - wrapRect.left;
        var mouseY = e.clientY - wrapRect.top;

        var ratio = newZoom / nav.zoomLevel;
        nav.panX = mouseX - ratio * (mouseX - nav.panX);
        nav.panY = mouseY - ratio * (mouseY - nav.panY);

        nav.zoomLevel = newZoom;
        nav.applyTransform();
    }, { passive: false });
};

/**
 * Apply current zoom/pan as CSS transform on the canvas and connector canvas.
 */
FamilyNavigator.prototype.applyTransform = function () {
    var dpr = window.devicePixelRatio || 1;
    var snappedPanX = Math.round(this.panX * dpr) / dpr;
    var snappedPanY = Math.round(this.panY * dpr) / dpr;
    var transformStr = 'translate(' + snappedPanX + 'px, ' + snappedPanY + 'px) scale(' + this.zoomLevel + ')';
    if (this.canvas) {
        this.canvas.style.transform = transformStr;
    }
    if (this.connCanvas) {
        this.connCanvas.style.transform = transformStr;
    }
    if (this.iconCanvas) {
        this.iconCanvas.style.transform = transformStr;
    }

    // Update zoom display
    var display = document.getElementById(this.cardPrefix + '_zoomDisplay');
    if (display) {
        display.textContent = Math.round(this.zoomLevel * 100) + '%';
    }
};

// ==========================================================================
// TOOLBAR
// ==========================================================================

FamilyNavigator.prototype.initToolbar = function () {
    var nav = this;
    var prefix = this.cardPrefix;

    var btnZoomIn = document.getElementById(prefix + '_btnZoomIn');
    if (btnZoomIn) {
        btnZoomIn.addEventListener('click', function () {
            nav.zoomLevel = Math.min(nav.zoomMax, Math.round((nav.zoomLevel + nav.zoomStep) * 100) / 100);
            nav.applyTransform();
        });
    }

    var btnZoomOut = document.getElementById(prefix + '_btnZoomOut');
    if (btnZoomOut) {
        btnZoomOut.addEventListener('click', function () {
            nav.zoomLevel = Math.max(nav.zoomMin, Math.round((nav.zoomLevel - nav.zoomStep) * 100) / 100);
            nav.applyTransform();
        });
    }

    var btnZoomReset = document.getElementById(prefix + '_btnZoomReset');
    if (btnZoomReset) {
        btnZoomReset.addEventListener('click', function () {
            nav.zoomLevel = 1.0;
            nav.focusOrigin();
        });
    }

    var btnFullscreen = document.getElementById(prefix + '_btnFullscreen');
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', function () {
            nav.toggleFullscreen();
        });
    }

    var btnShare = document.getElementById(prefix + '_btnShare');
    if (btnShare) {
        btnShare.addEventListener('click', function () {
            nav.copyShareLink(btnShare);
        });
    }

    // Store button refs for enabling/disabling
    this._toolbarButtons = {
        zoomIn:     document.getElementById(prefix + '_btnZoomIn'),
        zoomOut:    btnZoomOut,
        zoomReset:  btnZoomReset,
        fullscreen: btnFullscreen,
        share:      btnShare
    };

    // Sources toggle
    var toggleSources = document.getElementById(prefix + '_toggleSources');
    if (toggleSources) {
        toggleSources.checked = nav.showSources;
        toggleSources.addEventListener('change', function () {
            nav.showSources = this.checked;
            nav.measureAndRender();
            nav._toggleSourcesVisibility();
        });
    }

    // Focus chip — click to open search panel
    if (this.focusChip) {
        this.focusChip.addEventListener('click', function () {
            nav.openSearchPanel();
        });
        this.focusChip.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                nav.openSearchPanel();
            }
        });
    }

    // Search cancel button
    if (this.searchCancel) {
        this.searchCancel.addEventListener('click', function () {
            nav.closeSearchPanel();
        });
    }

    // Close search panel on Escape
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && nav.searchPanel && nav.searchPanel.classList.contains('sp-search-panel-open')) {
            nav.closeSearchPanel();
        }
    });

    // Close search panel on click outside
    document.addEventListener('mousedown', function (e) {
        if (nav.searchPanel && nav.searchPanel.classList.contains('sp-search-panel-open')) {
            if (!nav.searchPanel.contains(e.target) && (!nav.focusChip || !nav.focusChip.contains(e.target))) {
                nav.closeSearchPanel();
            }
        }
    });

    // Focus person chip — initial render
    nav._updateFocusPersonBox();
};

// ==========================================================================
// SEARCH — person autocomplete and navigation
// ==========================================================================

FamilyNavigator.prototype.initSearch = function () {
    var nav = this;
    var searchTimeout = null;

    if (!this.searchInput || !this.searchResults) return;

    // Input handler with debounce
    this.searchInput.addEventListener('input', function () {
        var query = nav.searchInput.value.trim();
        nav.selectedXref = '';

        if (searchTimeout) clearTimeout(searchTimeout);

        if (query.length < 2) {
            nav.searchResults.innerHTML = '';
            nav.searchResults.classList.remove('sp-show');
            return;
        }

        searchTimeout = setTimeout(function () {
            nav.fetchSearchResults(query);
        }, 300);
    });

    // Enter key in search input — navigate to first result or selected
    this.searchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;

        if (!nav.selectedXref && nav.latestSearchResults && nav.latestSearchResults.length > 0) {
            nav.selectedXref = nav.latestSearchResults[0].xref;
        }

        if (nav.selectedXref) {
            e.preventDefault();
            nav._navigateFromSearch(nav.selectedXref);
        }
    });
};

FamilyNavigator.prototype.fetchSearchResults = function (query) {
    var nav = this;
    var url = this.searchUrl 
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&q=' + encodeURIComponent(query);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            try {
                var results = nav._normalizeSearchResults(xhr.responseText);
                nav.latestSearchResults = results;
                nav.renderSearchResults(results);
            } catch (e) {
                console.error('SP Tree Navigator: search parse error', e);
                nav.latestSearchResults = [];
                nav.renderSearchResults([]);
            }
        }
    };
    xhr.send();
};

/**
 * Normalize search endpoint payload to an array of {xref, name, years}.
 * Accepts plain arrays and common wrapped object formats.
 */
FamilyNavigator.prototype._normalizeSearchResults = function (rawText) {
    var parsed = JSON.parse(rawText);

    if (Array.isArray(parsed)) {
        return parsed;
    }

    if (parsed && Array.isArray(parsed.results)) {
        return parsed.results;
    }

    if (parsed && Array.isArray(parsed.data)) {
        return parsed.data;
    }

    return [];
};

FamilyNavigator.prototype.renderSearchResults = function (results) {
    this.searchResults.innerHTML = '';
    this.searchResults.classList.remove('sp-show');
    this.searchLookup = {};

    if (!Array.isArray(results) || results.length === 0) {
        if (this.searchInput && this.searchInput.value.trim().length >= 2) {
            var noResult = document.createElement('div');
            noResult.className = 'sp-search-item sp-no-result';
            noResult.textContent = 'No results found';
            this.searchResults.appendChild(noResult);
            this.searchResults.classList.add('sp-show');
        }
        return;
    }

    var nav = this;
    for (var i = 0; i < results.length; i++) {
        var item = results[i];

        // Visual result item
        var el = document.createElement('div');
        el.className = 'sp-search-item';
        el.dataset.xref = item.xref;

        if (item.thumb) {
            var thumb = document.createElement('img');
            thumb.className = 'sp-search-item-thumb';
            thumb.src = item.thumb;
            thumb.alt = '';
            el.appendChild(thumb);
        }

        var info = document.createElement('div');
        info.className = 'sp-search-item-info';

        var nameEl = document.createElement('span');
        nameEl.className = 'sp-search-name';
        nameEl.textContent = item.name || '?';
        info.appendChild(nameEl);

        if (item.years) {
            var yearsEl = document.createElement('span');
            yearsEl.className = 'sp-search-years';
            yearsEl.textContent = item.years;
            info.appendChild(yearsEl);
        }

        el.appendChild(info);

        (function(xref) {
            el.addEventListener('click', function () {
                nav._navigateFromSearch(xref);
            });
        })(item.xref);

        this.searchResults.appendChild(el);
    }

    this.searchResults.classList.add('sp-show');
};

FamilyNavigator.prototype._escapeHtml = function (str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
};

/**
 * Set currentRootXref and activate spouse ancestor line if the target
 * person ended up as spouse due to gender swap.
 * @param {string|null} targetXref - the xref the user actually wanted to see
 */
FamilyNavigator.prototype._setCurrentXref = function (targetXref) {
    var rootNode = this.nodeMap[this.treeData.rootId];
    if (!rootNode || !rootNode.person) return;

    // Default: root person's own xref
    this.currentRootXref = rootNode.person.xref;

    // Check if the target ended up as spouse (gender swap)
    if (targetXref && targetXref !== rootNode.person.xref && rootNode.families) {
        for (var fi = 0; fi < rootNode.families.length; fi++) {
            if (rootNode.families[fi].spouse && rootNode.families[fi].spouse.xref === targetXref) {
                this.currentRootXref = targetXref;
                this.activeLines[this.treeData.rootId] = 1;
                break;
            }
        }
    }
};

/**
 * Build a shareable URL for the current tree view and copy it to clipboard.
 */
FamilyNavigator.prototype.copyShareLink = function (btnEl) {
    var url = new URL(window.location.href);
    if (this.currentRootXref) {
        url.searchParams.set('xref', this.currentRootXref);
    }
    if (this.showSources) {
        url.searchParams.set('sources', '1');
    } else {
        url.searchParams.delete('sources');
    }
    var shareUrl = url.toString();

    navigator.clipboard.writeText(shareUrl).then(function () {
        // Brief visual feedback — swap icon to checkmark
        var original = btnEl.innerHTML;
        btnEl.innerHTML = '&#x2705;';
        setTimeout(function () { btnEl.innerHTML = original; }, 1500);
    }).catch(function () {
        // Fallback for older browsers / non-HTTPS
        var ta = document.createElement('textarea');
        ta.value = shareUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        var original = btnEl.innerHTML;
        btnEl.innerHTML = '&#x2705;';
        setTimeout(function () { btnEl.innerHTML = original; }, 1500);
    });
};

// ==========================================================================
// FOCUS / CENTER
// ==========================================================================

FamilyNavigator.prototype.focusOrigin = function () {
    this.focusNode(this.treeData.rootId);
};

/**
 * Center the viewport on a specific node.
 */
FamilyNavigator.prototype.focusNode = function (nodeId) {
    if (!this.container) return;
    var layout = this.layoutMap[nodeId];
    if (!layout) return;

    var wrapRect = this.container.getBoundingClientRect();

    var targetX = layout.centerX * this.zoomLevel;
    var targetY = (layout.y + layout.h / 2) * this.zoomLevel;

    this.panX = wrapRect.width / 2 - targetX;
    this.panY = wrapRect.height / 2 - targetY;
    this.applyTransform();
};

// ==========================================================================
// LOADER / OVERLAY
// ==========================================================================

FamilyNavigator.prototype.showLoader = function (show) {
    if (this.loaderIcon) {
        this.loaderIcon.classList.toggle('sp-loading', show);
    }
    if (show) {
        this.showOverlay();
    } else {
        this.hideOverlay();
    }
};

FamilyNavigator.prototype.showOverlay = function () {
    if (this.overlay) {
        this.overlay.classList.add('sp-overlay-active');
    }
};

FamilyNavigator.prototype.hideOverlay = function () {
    if (this.overlay) {
        this.overlay.classList.remove('sp-overlay-active');
    }
};

// ==========================================================================
// FOCUS PERSON BOX
// ==========================================================================

/**
 * Update the focus-person chip in the toolbar with the current root person.
 */
FamilyNavigator.prototype._updateFocusPersonBox = function () {
    if (!this.focusAvatar || !this.focusName) return;

    var rootNode = this.nodeMap && this.treeData ? this.nodeMap[this.treeData.rootId] : null;
    if (!rootNode || !rootNode.person) {
        this.focusAvatar.innerHTML = '';
        this.focusName.textContent = 'Search person\u2026';
        if (this.focusChip) this.focusChip.classList.add('sp-focus-chip-empty');
        this._updateToolbarState(false);
        return;
    }

    var p = rootNode.person;
    var displayPerson = p;
    if (this.currentRootXref && this.currentRootXref !== p.xref && rootNode.families) {
        for (var i = 0; i < rootNode.families.length; i++) {
            var sp = rootNode.families[i].spouse;
            if (sp && sp.xref === this.currentRootXref) {
                displayPerson = sp;
                break;
            }
        }
    }

    this.focusAvatar.innerHTML = '';
    if (displayPerson.thumb) {
        var img = document.createElement('img');
        img.className = 'sp-focus-chip-img';
        img.src = displayPerson.thumb;
        img.alt = displayPerson.name || '';
        this.focusAvatar.appendChild(img);
    } else {
        this.focusAvatar.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c-4 0-7 1.8-7 3v1h14v-1c0-1.2-3-3-7-3z" fill="currentColor"/></svg>';
    }

    this.focusName.textContent = displayPerson.name || '?';
    if (this.focusChip) this.focusChip.classList.remove('sp-focus-chip-empty');
    this._updateToolbarState(true);
};

/**
 * Enable or disable toolbar action buttons depending on whether a tree is loaded.
 */
FamilyNavigator.prototype._updateToolbarState = function (hasTree) {
    if (!this._toolbarButtons) return;
    var btns = this._toolbarButtons;
    for (var key in btns) {
        if (btns.hasOwnProperty(key) && btns[key]) {
            btns[key].disabled = !hasTree;
        }
    }
    // Also disable sources toggle
    var toggleSources = document.getElementById(this.cardPrefix + '_toggleSources');
    if (toggleSources) toggleSources.disabled = !hasTree;
};

// ==========================================================================
// SEARCH PANEL — open / close / navigate
// ==========================================================================

FamilyNavigator.prototype.openSearchPanel = function () {
    if (!this.searchPanel) return;

    // Position the fixed panel below the focus chip
    if (this.focusChip) {
        var rect = this.focusChip.getBoundingClientRect();
        this.searchPanel.style.top = (rect.bottom + 6) + 'px';
        this.searchPanel.style.left = rect.left + 'px';
    }

    this.searchPanel.classList.add('sp-search-panel-open');
    if (this.searchInput) {
        this.searchInput.value = '';
        this.searchInput.focus();
    }
    this.searchResults.innerHTML = '';
    this.searchResults.classList.remove('sp-show');
};

FamilyNavigator.prototype.closeSearchPanel = function () {
    if (!this.searchPanel) return;
    this.searchPanel.classList.remove('sp-search-panel-open');
    if (this.searchInput) this.searchInput.value = '';
    this.searchResults.innerHTML = '';
    this.searchResults.classList.remove('sp-show');
    this.selectedXref = '';
    this.latestSearchResults = [];
};

FamilyNavigator.prototype._navigateFromSearch = function (xref) {
    this.closeSearchPanel();
    this.navigateTo(xref);
};

// ==========================================================================
// SOURCES VISIBILITY TOGGLE
// ==========================================================================

/**
 * Show or hide source/note counters on all person cards and couple chips.
 */
FamilyNavigator.prototype._toggleSourcesVisibility = function () {
    var container = this.container;
    if (!container) return;

    var show = this.showSources;

    // Card-level action count badges
    var badges = container.querySelectorAll('.sp-action-count');
    for (var i = 0; i < badges.length; i++) {
        badges[i].style.display = show ? '' : 'none';
    }

    // Couple-chip icon rows
    var chipIcons = container.querySelectorAll('.sp-couple-chip-icons');
    for (var j = 0; j < chipIcons.length; j++) {
        chipIcons[j].style.display = show ? 'inline-flex' : 'none';
    }
};

// ==========================================================================
// FULLSCREEN
// ==========================================================================

FamilyNavigator.prototype.toggleFullscreen = function () {
    var wrap = this.container;
    var nav = this;
    if (!wrap) return;
    var chartParent = wrap.closest('.wt-chart-interactive');
    if (chartParent) {
        chartParent.classList.toggle('sp-fullview');
    }
    setTimeout(function () {
        // Re-sync overlay and re-center after the resize
        nav._syncIconOverlayBounds();
    }, 100);
};

