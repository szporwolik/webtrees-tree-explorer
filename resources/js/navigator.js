/**
 * SP Tree Explorer for webtrees
 * Family Navigator — JSON → Layout → Cards → Canvas connectors
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

/**
 * Translation helper — returns translated string from PHP-injected dictionary.
 * Supports %s placeholders replaced left-to-right by additional arguments.
 */
function __(key) {
    var t = (window.wtpTranslations && window.wtpTranslations[key]) || key;
    for (var i = 1; i < arguments.length; i++) {
        t = t.replace('%s', arguments[i]);
    }
    return t;
}

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
    this.activeLines    = {};   // nodeId -> lineIndex (0 = self/default, 1..n = spouse families)

    // Track the currently displayed root person xref (for share links)
    this.currentRootXref = '';

    // Base person xref — the person the tree was originally loaded for (home button)
    this.baseXref = this.container ? this.container.getAttribute('data-base-xref') || '' : '';

    // Embedded-profile mode metadata
    this.profileView = this.container ? this.container.getAttribute('data-profile-view') === '1' : false;
    this.fullPageUrl = this.container ? this.container.getAttribute('data-full-page-url') || '' : '';

    // Expansion history — records each AJAX expansion for share-link replay
    this._expansionHistory = []; // [{type:'lazy'|'ancestor', fid, pid, dir?, lineIndex?}]

    // Debug mode — append ?debug=1 to URL to enable console logging
    this.debug = (new URL(window.location.href).searchParams.get('debug') === '1');

    // Re-render when a hidden container becomes visible (e.g. profile-page tab).
    this._lastContainerSize = { width: 0, height: 0 };
    if (this.container && typeof ResizeObserver !== 'undefined') {
        this._containerObserver = new ResizeObserver(function (entries) {
            for (var i = 0; i < entries.length; i++) {
                var rect = entries[i].contentRect;
                var wasHidden = nav._lastContainerSize.width === 0 || nav._lastContainerSize.height === 0;
                nav._lastContainerSize = { width: rect.width, height: rect.height };
                if (rect.width > 0 && rect.height > 0 && wasHidden) {
                    window.requestAnimationFrame(function () {
                        nav.measureAndRender();
                        nav._setCurrentXref(nav.baseXref || null);
                        if (nav.startExpanded) {
                            nav.focusOrigin();
                        }
                    });
                }
            }
        });
        this._containerObserver.observe(this.container);
    }

    // Sources visibility state (read from data attribute, default: off)
    var defaultSources = this.container ? this.container.getAttribute('data-default-sources') : '0';
    this.showSources = defaultSources === '1';

    // Details visibility state (default: on, read from data attribute)
    var defaultDetails = this.container ? this.container.getAttribute('data-default-details') : '1';
    this.showDetails = defaultDetails !== '0';

    // Advanced controls visibility state (default: on, read from data attribute)
    var defaultAdvanced = this.container ? this.container.getAttribute('data-default-advanced') : '1';
    this.showAdvancedControls = defaultAdvanced !== '0';

    // DOM card references
    this.cardElements   = {};   // nodeId -> DOM element

    // Build indexes and render
    this.buildIndex(this.treeData);

    // Determine the actual target xref (may differ from root person due to gender swap)
    var urlParams = new URL(window.location.href).searchParams;
    var urlXref = urlParams.get('xref');
    this._setCurrentXref(urlXref);

    // Restore toggle states from URL (override defaults)
    if (urlParams.has('sources')) {
        this.showSources = urlParams.get('sources') === '1';
    }
    if (urlParams.has('details')) {
        this.showDetails = urlParams.get('details') === '1';
    }
    if (urlParams.has('advanced')) {
        this.showAdvancedControls = urlParams.get('advanced') === '1';
    }

    // Apply initial container classes
    this._applyToggleClasses();

    this.measureAndRender();

    // Init interactions
    this.initPanZoom();
    this.initToolbar();
    this.initSearch();

    // Restore view state from URL — expansions, then zoom/position
    var pendingExp = urlParams.get('exp');
    var pendingAnc = urlParams.get('anc');
    var urlZoom = urlParams.get('z');
    var urlCx = urlParams.get('cx');
    var urlCy = urlParams.get('cy');
    var hasViewState = urlZoom && urlCx && urlCy;

    if (pendingExp || pendingAnc) {
        // Replay expansions, then restore zoom/position
        var expList = pendingExp ? pendingExp.split(',') : [];
        var ancList = pendingAnc ? pendingAnc.split(',') : [];
        var self = this;
        this._replayExpansions(expList, ancList, function () {
            if (hasViewState) {
                self._restoreViewState(parseFloat(urlZoom), parseFloat(urlCx), parseFloat(urlCy));
            } else if (self.startExpanded) {
                self.focusOrigin();
            }
            self.hideOverlay();
            self._updateFocusPersonBox();
        });
    } else {
        // No expansions to replay — restore zoom/position directly
        if (hasViewState) {
            this._restoreViewState(parseFloat(urlZoom), parseFloat(urlCx), parseFloat(urlCy));
        } else if (this.startExpanded) {
            this.focusOrigin();
        }
        this.hideOverlay();
        this._updateFocusPersonBox();
    }
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

/**
 * Debug log — only prints when ?debug=1 is in the URL.
 */
FamilyNavigator.prototype._dbg = function () {
    if (!this.debug) return;
    var args = ['[SPTree]'];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
};

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

    this._dbg('buildIndex', 'nodes=' + data.nodes.length, 'edges=' + data.edges.length, 'rootId=' + data.rootId);
};

/**
 * Rebuild childrenMap and parentEdges from edgeMap.
 * Ensures consistent state after incremental merge operations,
 * including the same familyIndex + birth-date sort as buildIndex.
 */
FamilyNavigator.prototype._rebuildRelationships = function () {
    this.childrenMap = {};
    this.parentEdges = {};

    for (var key in this.edgeMap) {
        var edge = this.edgeMap[key];
        if (!this.childrenMap[edge.from]) this.childrenMap[edge.from] = [];
        this.childrenMap[edge.from].push(edge.to);
        if (!this.parentEdges[edge.to]) this.parentEdges[edge.to] = [];
        this.parentEdges[edge.to].push(edge);
    }

    var self = this;
    for (var parentId in this.childrenMap) {
        this.childrenMap[parentId].sort(function (a, b) {
            var eaKey = parentId + '->' + a;
            var ebKey = parentId + '->' + b;
            var ea = self.edgeMap[eaKey];
            var eb = self.edgeMap[ebKey];
            var fa = (ea && ea.familyIndex !== undefined) ? ea.familyIndex : -1;
            var fb = (eb && eb.familyIndex !== undefined) ? eb.familyIndex : -1;
            if (fa !== fb) return fa - fb;

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
FamilyNavigator.prototype.measureSubtree = function (nodeId, _visited) {
    if (!_visited) _visited = {};
    if (_visited[nodeId]) return 0;
    _visited[nodeId] = true;

    var node = this.nodeMap[nodeId];
    if (!node) {
        this.layoutMap[nodeId] = { w: 0, subtreeW: 0 };
        return 0;
    }

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
        childrenTotalW += this.measureSubtree(children[i], _visited);
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
            if (fi > 0) {
                w += this.MULTI_SPOUSE_SEP;
            }
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
FamilyNavigator.prototype.positionSubtree = function (nodeId, x, y, _visited) {
    if (!_visited) _visited = {};
    if (_visited[nodeId]) return;
    _visited[nodeId] = true;

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

    // Filter out children whose layout was not computed (missing nodeMap entry)
    var measuredChildren = [];
    for (var i = 0; i < children.length; i++) {
        if (this.layoutMap[children[i]]) measuredChildren.push(children[i]);
    }
    children = measuredChildren;
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

    var familyGroups = [];
    var currentGroup = null;
    for (var ci = 0; ci < children.length; ci++) {
        var groupChildId = children[ci];
        var groupFamilyIndex = this._childFamilyIndex(nodeId, groupChildId);
        if (!currentGroup || currentGroup.familyIndex !== groupFamilyIndex) {
            currentGroup = { familyIndex: groupFamilyIndex, children: [], width: 0 };
            familyGroups.push(currentGroup);
        }
        currentGroup.children.push(groupChildId);
    }

    for (var gi = 0; gi < familyGroups.length; gi++) {
        var group = familyGroups[gi];
        var groupWidth = 0;
        for (var gj = 0; gj < group.children.length; gj++) {
            if (gj > 0) {
                groupWidth += this.H_GAP;
            }
            groupWidth += this.layoutMap[group.children[gj]].subtreeW;
        }
        group.width = groupWidth;
    }

    var useFamilyAlignedLayout = familyGroups.length > 1;
    for (var fgi = 0; fgi < familyGroups.length; fgi++) {
        if (familyGroups[fgi].familyIndex < 0) {
            useFamilyAlignedLayout = false;
            break;
        }
    }

    if (useFamilyAlignedLayout) {
        var groupGap = this.H_GAP + this.FAMILY_GROUP_GAP;
        var groupBoxes = [];

        for (var gbi = 0; gbi < familyGroups.length; gbi++) {
            var famGroup = familyGroups[gbi];
            var desiredCenter = this.getCoupleLineCenterX(layout, famGroup.familyIndex);
            var left = desiredCenter - famGroup.width / 2;

            if (groupBoxes.length > 0) {
                var prevBox = groupBoxes[groupBoxes.length - 1];
                left = Math.max(left, prevBox.right + groupGap);
            }

            groupBoxes.push({
                left: left,
                right: left + famGroup.width
            });
        }

        if (groupBoxes.length > 0) {
            var spanLeft = groupBoxes[0].left;
            var spanRight = groupBoxes[groupBoxes.length - 1].right;
            var shift = nodeCenterX - ((spanLeft + spanRight) / 2);
            for (var sgi = 0; sgi < groupBoxes.length; sgi++) {
                groupBoxes[sgi].left += shift;
                groupBoxes[sgi].right += shift;
            }
        }

        for (var pgi = 0; pgi < familyGroups.length; pgi++) {
            var placedGroup = familyGroups[pgi];
            var groupChildX = groupBoxes[pgi].left;
            for (var pgj = 0; pgj < placedGroup.children.length; pgj++) {
                var placedChildId = placedGroup.children[pgj];
                var placedLayout = this.layoutMap[placedChildId];
                this.positionSubtree(placedChildId, groupChildX, childY, _visited);
                groupChildX += placedLayout.subtreeW + this.H_GAP;
            }
        }
    } else {
        var childX = nodeCenterX - childrenTotalW / 2;

        // First pass: position all children
        for (var i = 0; i < children.length; i++) {
            var cid = children[i];
            var cLayout = this.layoutMap[cid];
            this.positionSubtree(cid, childX, childY, _visited);
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
FamilyNavigator.prototype._shiftSubtree = function (nodeId, dy, childrenOnly, _visited) {
    if (!_visited) _visited = {};
    if (_visited[nodeId]) return;
    _visited[nodeId] = true;

    if (!childrenOnly) {
        var l = this.layoutMap[nodeId];
        if (l && l.y !== undefined) {
            l.y += dy;
        }
    }
    var children = this.getVisibleChildren(nodeId);
    for (var i = 0; i < children.length; i++) {
        this._shiftSubtree(children[i], dy, false, _visited);
    }
};

/**
 * Main layout entry point.
 */
FamilyNavigator.prototype.layoutTree = function () {
    this.layoutMap = {};

    var visualRoot = this.findVisualRoot();
    if (!visualRoot || !this.nodeMap[visualRoot]) {
        return;
    }
    this.measureSubtree(visualRoot);
    this.positionSubtree(visualRoot, 0, 0);

    // Position orphaned ancestors — nodes added by in-place ancestor expansion
    // on side branches that are not reachable from the visual root's downward walk.
    // Each iteration positions one orphan; the loop cascades upward through chains.
    for (var oIter = 0; oIter < 50; oIter++) {
        var orphanId = null;
        var orphanChildId = null;
        var orphanEdge = null;
        for (var nid in this.nodeMap) {
            var ol = this.layoutMap[nid];
            if (ol && ol.x !== undefined) continue; // already positioned
            var vc = this.getVisibleChildren(nid);
            for (var ci = 0; ci < vc.length; ci++) {
                var cl = this.layoutMap[vc[ci]];
                if (cl && cl.x !== undefined) {
                    orphanId = nid;
                    orphanChildId = vc[ci];
                    orphanEdge = this.edgeMap[nid + '->' + vc[ci]] || null;
                    break;
                }
            }
            if (orphanId) break;
        }
        if (!orphanId) break;

        var nW = this.nodeWidth(orphanId);
        var cLayout = this.layoutMap[orphanChildId];

        // Determine X target: align above the specific card (person or spouse)
        // based on the connecting edge's lineIndex.
        var targetCenterX = cLayout.centerX;
        if (orphanEdge && orphanEdge.lineIndex !== undefined) {
            var childNode = this.nodeMap[orphanChildId];
            if (childNode && childNode.families && childNode.families.length > 0) {
                if (orphanEdge.lineIndex === 0) {
                    // Person side → center above the main person card.
                    targetCenterX = cLayout.x + this.CARD_W / 2;
                } else {
                    // Spouse side → center above the matching spouse card (1..n).
                    var cardOffset = orphanEdge.lineIndex * (this.CARD_W + this.COUPLE_GAP);
                    targetCenterX = cLayout.x + cardOffset + this.CARD_W / 2;
                }
            }
        }

        // Calculate target Y level
        var targetY = cLayout.y - this.nodeHeight(orphanId) - this.V_GAP;

        // Collision avoidance: collect all nodes at the same Y level and check overlap
        var sameLevelNodes = [];
        for (var oid in this.layoutMap) {
            if (oid === orphanId) continue;
            var ol = this.layoutMap[oid];
            if (!ol || ol.x === undefined) continue;
            if (Math.abs(ol.y - targetY) > 5) continue;
            sameLevelNodes.push(ol);
        }
        var oLeft = targetCenterX - nW / 2;
        var oRight = oLeft + nW;
        var hasOverlap = false;
        for (var si = 0; si < sameLevelNodes.length; si++) {
            var sl = sameLevelNodes[si];
            if (oLeft < sl.x + sl.w + this.H_GAP && oRight > sl.x - this.H_GAP) {
                hasOverlap = true;
                break;
            }
        }
        if (hasOverlap) {
            if (!orphanEdge || orphanEdge.lineIndex === 0) {
                // Person/left side — place to the left of all nodes at this Y
                var leftMost = Infinity;
                for (var si = 0; si < sameLevelNodes.length; si++) {
                    if (sameLevelNodes[si].x < leftMost) leftMost = sameLevelNodes[si].x;
                }
                targetCenterX = leftMost - this.H_GAP - nW / 2;
            } else {
                // Spouse/right side — place to the right of all nodes at this Y
                var rightMost = -Infinity;
                for (var si = 0; si < sameLevelNodes.length; si++) {
                    var rr = sameLevelNodes[si].x + sameLevelNodes[si].w;
                    if (rr > rightMost) rightMost = rr;
                }
                targetCenterX = rightMost + this.H_GAP + nW / 2;
            }
        }

        // Log existing parents of the child for overlap diagnosis
        var childPEdges = this.parentEdges[orphanChildId] || [];
        var parentInfo = childPEdges.map(function(pe) {
            var pl = this.layoutMap[pe.from];
            return pe.from + '(line=' + pe.lineIndex + ',x=' + (pl && pl.x !== undefined ? Math.round(pl.x) : '?') + ')';
        }.bind(this)).join(' ');
        this._dbg('layoutOrphan', orphanId, '→child=' + orphanChildId,
            'line=' + (orphanEdge ? orphanEdge.lineIndex : 'none'),
            'targetX=' + Math.round(targetCenterX),
            'childX=' + Math.round(cLayout.x), 'childCX=' + Math.round(cLayout.centerX),
            'overlap=' + hasOverlap, 'sameLevel=' + sameLevelNodes.length,
            'parents=[' + parentInfo + ']');

        // Directly position the orphan node above its positioned child.
        // Do NOT call positionSubtree — it would recurse and reposition
        // already-laid-out children, breaking the main layout.
        this.layoutMap[orphanId] = {
            w: nW,
            subtreeW: nW,
            x: targetCenterX - nW / 2,
            y: targetY,
            h: this.nodeHeight(orphanId),
            centerX: targetCenterX
        };
    }

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

    this._updateOriginHighlight();

    // Draw connectors on canvas
    this.drawConnectors(canvasW, canvasH);

    // Render floating ancestor icons in overlay
    this._renderIconOverlay(canvasW, canvasH);
};

/**
 * Keep the origin highlight on the actual focused/root person card,
 * even when the root couple was visually gender-swapped.
 */
FamilyNavigator.prototype._updateOriginHighlight = function () {
    if (!this.cardElements || !this.treeData) return;

    var rootId = this.treeData.rootId;
    var targetXref = this.currentRootXref || this.baseXref || '';

    for (var nodeId in this.cardElements) {
        var wrapper = this.cardElements[nodeId];
        if (!wrapper) continue;

        var cards = wrapper.querySelectorAll('.sp-card');
        if (!cards || cards.length === 0) continue;

        for (var i = 0; i < cards.length; i++) {
            cards[i].classList.remove('sp-origin');
        }

        if (nodeId !== rootId) {
            continue;
        }

        var matched = false;
        for (var ci = 0; ci < cards.length; ci++) {
            if ((cards[ci].dataset.xref || '') === targetXref && targetXref !== '') {
                cards[ci].classList.add('sp-origin');
                matched = true;
                break;
            }
        }

        if (!matched && cards[0]) {
            cards[0].classList.add('sp-origin');
        }
    }
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

    // Debug: Alt+Click on card dumps node info to console
    if (this.debug) {
        var nav = this;
        wrapper.addEventListener('click', function (e) {
            if (e.altKey || e.shiftKey) {
                e.stopPropagation();
                e.preventDefault();
                var n = nav.nodeMap[node.id];
                var layout = nav.layoutMap[node.id];
                var pEdges = nav.parentEdges[node.id] || [];
                var cEdges = nav.childrenMap[node.id] || [];

                // Detect which card was clicked
                var clickedCard = e.target.closest('.sp-card');
                var cards = wrapper.querySelectorAll('.sp-card');
                var cardIndex = -1;
                for (var ci = 0; ci < cards.length; ci++) {
                    if (cards[ci] === clickedCard) { cardIndex = ci; break; }
                }
                var clickedPerson;
                if (cardIndex <= 0) {
                    clickedPerson = n ? n.person : null;
                } else {
                    clickedPerson = (n && n.families && n.families[cardIndex - 1]) ? n.families[cardIndex - 1].spouse : null;
                }

                console.group('[SPTree] DEBUG node ' + node.id + ' (card ' + cardIndex + ')');
                console.log('clicked:', clickedPerson ? clickedPerson.xref : '?', '| name:', clickedPerson ? clickedPerson.name : '?', '| sex:', clickedPerson ? clickedPerson.sex : '?');
                console.log('person:', n ? n.person.xref : '?', '| name:', n ? n.person.name : '?');
                console.log('gen:', n ? n.generation : '?', '| swap:', n ? n.genderSwapped : '?', '| oxref:', n ? n.originalChildXref : '?');
                console.log('families:', n && n.families ? n.families.length : 0,
                    n && n.families ? n.families.map(function(f, i) {
                        return 'F' + i + ':{fam=' + (f.familyXref || '?') + ' person=' + (n.person.xref || '?') + ' spouse=' + (f.spouse ? f.spouse.xref : 'none') + '}';
                    }) : []);
                console.log('layout:', layout ? { x: Math.round(layout.x), y: Math.round(layout.y), w: layout.w, centerX: Math.round(layout.centerX) } : 'none');
                console.log('parentEdges:', pEdges.map(function(pe) { return { from: pe.from, line: pe.lineIndex, type: pe.line }; }));
                console.log('children:', cEdges);
                console.log('raw node:', n);
                console.groupEnd();
            }
        });
    }

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
    var spouseAncestorsVisible = {};
    var parentEdgesHere = this.parentEdges[node.id] || [];
    for (var ei = 0; ei < parentEdgesHere.length; ei++) {
        var pe = parentEdgesHere[ei];
        // Only count as visible if the parent node is actually positioned (visible in tree)
        var parentLayout = this.layoutMap[pe.from];
        if (!parentLayout || parentLayout.x === undefined) continue;
        if (pe.lineIndex !== undefined) {
            // Ancestor-line edge: 0 = person side, 1..n = spouse cards in family order.
            if (pe.lineIndex === 0) {
                personAncestorsVisible = true;
            } else {
                spouseAncestorsVisible[pe.lineIndex] = true;
            }
        } else {
            // Downward parent-child edge: use originalChildXref to find which side.
            var oxref = node.originalChildXref;
            var spouseMatchIndex = -1;
            if (oxref && node.families) {
                for (var fmi = 0; fmi < node.families.length; fmi++) {
                    var candidateSpouse = node.families[fmi].spouse;
                    if (candidateSpouse && candidateSpouse.xref === oxref) {
                        spouseMatchIndex = fmi;
                        break;
                    }
                }
            }
            if (spouseMatchIndex >= 0) {
                spouseAncestorsVisible[spouseMatchIndex + 1] = true;
            } else {
                personAncestorsVisible = true;
            }
        }
    }

    this._dbg('ancestorIcons', node.id,
        'person=' + (node.person ? node.person.xref : '?'),
        'pHasParents=' + personHasParents, 'pVis=' + personAncestorsVisible,
        'sVis=' + Object.keys(spouseAncestorsVisible).join(','),
        'oxref=' + node.originalChildXref,
        'spouses=' + (node.families ? node.families.length : 0),
        'edges=' + parentEdgesHere.length,
        'gen=' + node.generation,
        'swap=' + (node.genderSwapped || false));

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
            lineIndex: 0,
            rebaseOnly: node.generation < 0
        });
    }
    for (var si = 0; si < spouseCards.length; si++) {
        var sc = spouseCards[si];
        var spouseLineIndex = si + 1;
        if (sc.family.spouse && sc.family.spouseHasParents) {
            if (spouseAncestorsVisible[spouseLineIndex]) continue;
            wrapper._ancestorIcons.push({
                xref: sc.family.spouse.xref, target: 'spouse', index: si,
                nodeId: node.id,
                familyXref: sc.family.spouseParentFamilyXref || '',
                childXref: sc.family.spouse.xref,
                lineIndex: spouseLineIndex,
                rebaseOnly: node.generation < 0
            });
        }
    }

    return wrapper;
};

/**
 * Create a single person card DOM element.
 */
FamilyNavigator.prototype.createPersonCard = function (personData, isOrigin) {
    var genderClass = personData.sex === 'M' ? 'sp-male' : (personData.sex === 'F' ? 'sp-female' : 'sp-unknown');
    var card = document.createElement('div');
    card.className = 'sp-card ' + genderClass + (isOrigin ? ' sp-origin' : '') + (personData.isUnknown ? ' sp-card-unknown' : '') + (personData.isPrivate ? ' sp-card-private' : '');
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

    // Private person — simplified card with lock icon and "Private" label
    if (personData.isPrivate) {
        var person = document.createElement('div');
        person.className = 'sp-person sp-private-person';
        var lockIcon = document.createElement('div');
        lockIcon.className = 'sp-private-icon';
        lockIcon.innerHTML = '<svg viewBox="0 0 16 16" width="20" height="20"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
        person.appendChild(lockIcon);
        var privateName = document.createElement('div');
        privateName.className = 'sp-private-label';
        privateName.textContent = personData.name; // "Private" from server
        person.appendChild(privateName);
        card.appendChild(person);
        return card;
    }

    // Black ribbon for deceased persons
    if (personData.isDead) {
        var ribbon = document.createElement('span');
        ribbon.className = 'sp-deceased-ribbon';
        card.appendChild(ribbon);
    }

    card.appendChild(this._createPersonInfoSection(personData));
    card.appendChild(this._createCardActions(personData));

    return card;
};

/**
 * Build person info section: avatar, name, dates, parent ages at birth.
 */
FamilyNavigator.prototype._createPersonInfoSection = function (personData) {
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
        avatarWrap.title = __('Add photo');
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
    nameLink.setAttribute('aria-label', __('View %s profile', personData.name));

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
    if (personData.birthPlace) placeTitleParts.push(__('Birth place:') + ' ' + personData.birthPlace);
    if (personData.deathPlace) placeTitleParts.push(__('Death place:') + ' ' + personData.deathPlace);
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
            fatherAge.title = __("Father's age at birth:") + ' ' + personData.fatherAgeAtBirth;

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
            motherAge.title = __("Mother's age at birth:") + ' ' + personData.motherAgeAtBirth;

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
    return person;
};

/**
 * Build the actions row for a person card (sources/notes/media links + edit buttons).
 */
FamilyNavigator.prototype._createCardActions = function (personData) {
    var nav = this;
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
        link.setAttribute('aria-label', __('%s for %s', label, personData.name));
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
    var addSourceLink = quickAction(personUrl ? personUrl + '#sources_tab' : '', __('Sources'), srcIcon, sourceCount);
    var addNoteLink = quickAction(personUrl ? personUrl + '#notes' : '', __('Notes'), noteIcon, noteCount);
    var addMediaLink = quickAction(personUrl ? personUrl + '#media' : '', __('Media'), mediaIcon, mediaCount);
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
        addNoteBtn.title = __('Add note');
        addNoteBtn.setAttribute('aria-label', __('%s for %s', __('Add note'), personData.name));
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
        editFamilyLink.title = __('Edit family');
        editFamilyLink.setAttribute('aria-label', __('%s for %s', __('Edit family'), personData.name));
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
        viewLink.title = __('Edit person');
        viewLink.setAttribute('aria-label', __('Edit %s', personData.name));
        viewLink.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><line x1="9.5" y1="3.5" x2="12.5" y2="6.5" stroke="currentColor" stroke-width="1.3"/></svg>';
        actionsRight.appendChild(viewLink);
    }

    // 4. Rebase/center tree button
    if (personData.xref) {
        var rebaseBtn = document.createElement('button');
        rebaseBtn.type = 'button';
        rebaseBtn.className = 'sp-card-action-btn';
        rebaseBtn.title = __('Center tree on this person');
        rebaseBtn.setAttribute('aria-label', __('Center tree on %s', personData.name));
        rebaseBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/><line x1="8" y1="0" x2="8" y2="4" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="12" x2="8" y2="16" stroke="currentColor" stroke-width="1.3"/><line x1="0" y1="8" x2="4" y2="8" stroke="currentColor" stroke-width="1.3"/><line x1="12" y1="8" x2="16" y2="8" stroke="currentColor" stroke-width="1.3"/></svg>';
        (function(xref) {
            rebaseBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nav._dbg('CLICK cardRebase', xref);
                nav.navigateTo(xref);
            });
        })(personData.xref);
        actionsRight.appendChild(rebaseBtn);
    }

    actions.appendChild(actionsRight);
    return actions;
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
        lineEl.title = __('Open family page');
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
    if (isDivorced) tipParts.push(__('Divorced'));
    else if (isMarried) tipParts.push(__('Married'));
    else tipParts.push(__('Partnership'));
    if (familyData.marriageDate) tipParts.push(__('Marriage:') + ' ' + familyData.marriageDate);
    if (familyData.divorceDate) tipParts.push(__('Divorce:') + ' ' + familyData.divorceDate);
    if (Number.isFinite(familyData.husbandAgeAtMarriage)) tipParts.push(__('♂ age at marriage:') + ' ' + familyData.husbandAgeAtMarriage);
    if (Number.isFinite(familyData.wifeAgeAtMarriage)) tipParts.push(__('♀ age at marriage:') + ' ' + familyData.wifeAgeAtMarriage);
    if (familyData.marriagePlace) tipParts.push(__('Marriage place:') + ' ' + familyData.marriagePlace);
    if (familyData.divorcePlace) tipParts.push(__('Divorce place:') + ' ' + familyData.divorcePlace);
    if (familyData.durationLabel) tipParts.push(__('Duration:') + ' ' + familyData.durationLabel);
    if (Number.isFinite(familyData.familySourceCount) || Number.isFinite(familyData.familyNoteCount)) {
        tipParts.push(__('Family sources:') + ' ' + (familyData.familySourceCount || 0));
        tipParts.push(__('Family notes:') + ' ' + (familyData.familyNoteCount || 0));
        tipParts.push(__('Family media:') + ' ' + (familyData.familyMediaCount || 0));
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

            iconsRow.appendChild(famIcon(srcIcon, famSourceCount, __('Sources')));
            iconsRow.appendChild(famIcon(noteIconSvg, famNoteCount, __('Notes')));
            iconsRow.appendChild(famIcon(mediaIconSvg, famMediaCount, __('Media')));
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
        brokenRings.innerHTML = '<svg viewBox="0 0 24 14" width="60" height="36"><circle cx="8" cy="7" r="5" fill="' + wtpCSSColors.ringFemaleFill + '" fill-opacity="0.35" stroke="' + wtpCSSColors.ringFemaleStroke + '" stroke-width="1.8" opacity="0.55"/><circle cx="16" cy="7" r="5" fill="' + wtpCSSColors.ringMaleFill + '" fill-opacity="0.35" stroke="' + wtpCSSColors.ringMaleStroke + '" stroke-width="1.8" opacity="0.55"/><line x1="4" y1="2" x2="20" y2="12" stroke="' + wtpCSSColors.divorceLine + '" stroke-width="1.7"/></svg>';
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
        rings.innerHTML = '<svg viewBox="0 0 24 14" width="60" height="36"><circle cx="8" cy="7" r="5" fill="' + wtpCSSColors.ringFemaleFill + '" fill-opacity="0.75" stroke="' + wtpCSSColors.ringFemaleStroke + '" stroke-width="1.8"/><circle cx="16" cy="7" r="5" fill="' + wtpCSSColors.ringMaleFill + '" fill-opacity="0.75" stroke="' + wtpCSSColors.ringMaleStroke + '" stroke-width="1.8"/></svg>';
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
        // Unmarried couple — dashed gender-colored circles (partnership)
        var heart = document.createElement('span');
        heart.className = 'sp-couple-rings';
        heart.innerHTML = '<svg viewBox="0 0 24 14" width="60" height="36"><circle cx="8" cy="7" r="5" fill="' + wtpCSSColors.ringFemaleFill + '" fill-opacity="0.55" stroke="' + wtpCSSColors.ringFemaleStroke + '" stroke-width="1.6" stroke-dasharray="3 2"/><circle cx="16" cy="7" r="5" fill="' + wtpCSSColors.ringMaleFill + '" fill-opacity="0.55" stroke="' + wtpCSSColors.ringMaleStroke + '" stroke-width="1.6" stroke-dasharray="3 2"/></svg>';
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
            btn.style.position = 'absolute';
            btn.style.left = iconX + 'px';
            btn.style.top = iconY + 'px';

            if (info.rebaseOnly) {
                // Descendant node — expanding ancestors would leave the current tree.
                // Option C: parent–child chain with curved redirect arrow.
                var rc = cc.connectorLine;
                btn.className = 'sp-ancestor-expand sp-ancestor-rebase';
                btn.title = __('Navigate to ancestors');
                btn.innerHTML = '<svg viewBox="0 0 60 22" width="67" height="17" aria-hidden="true">'
                    + '<line x1="30" y1="15" x2="30" y2="7" stroke="' + rc + '" stroke-width="1.6" stroke-linecap="round"/>'
                    + '<circle cx="30" cy="18" r="3" fill="' + rc + '" fill-opacity="0.35" stroke="' + rc + '" stroke-width="1.8"/>'
                    + '<circle cx="30" cy="4" r="3" fill="' + rc + '" fill-opacity="0.25" stroke="' + rc + '" stroke-width="1.6" stroke-opacity="0.55"/>'
                    + '<path d="M38,17 C46,17 46,4 38,4" fill="none" stroke="' + rc + '" stroke-width="1.4" stroke-opacity="0.7"/>'
                    + '<polygon points="38,1.5 42,4 38,6.5" fill="' + rc + '" fill-opacity="0.7"/>'
                    + '</svg>';
                (function(iconInfo) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        nav._dbg('CLICK rebaseIcon', iconInfo.xref);
                        nav.navigateTo(iconInfo.xref);
                    });
                })(info);
            } else {
                // Ancestor/origin node — Option D: mini pedigree (2 parents + 1 child).
                btn.className = 'sp-ancestor-expand';
                btn.title = __('Expand ancestors');
                btn.innerHTML = '<svg viewBox="0 0 60 22" width="67" height="17" aria-hidden="true">'
                    + '<line x1="30" y1="15" x2="18" y2="7" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
                    + '<line x1="30" y1="15" x2="42" y2="7" stroke="' + cc.connectorLine + '" stroke-width="1.6" stroke-linecap="round"/>'
                    + '<circle cx="18" cy="4" r="3.2" fill="' + cc.ringMaleFill + '" fill-opacity="0.55" stroke="' + cc.ringMaleStroke + '" stroke-width="1.6"/>'
                    + '<circle cx="42" cy="4" r="3.2" fill="' + cc.ringFemaleFill + '" fill-opacity="0.55" stroke="' + cc.ringFemaleStroke + '" stroke-width="1.6"/>'
                    + '<circle cx="30" cy="18" r="3" fill="' + cc.connectorLine + '" fill-opacity="0.35" stroke="' + cc.connectorLine + '" stroke-width="1.8"/>'
                    + '</svg>';
                (function(iconInfo, nodeId) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        if (iconInfo.familyXref) {
                            nav._dbg('CLICK expandAncestor', nodeId, 'fam=' + iconInfo.familyXref, 'child=' + iconInfo.childXref, 'line=' + iconInfo.lineIndex);
                            nav.expandAncestorInPlace(nodeId, iconInfo.familyXref, iconInfo.childXref, iconInfo.lineIndex);
                        } else {
                            nav._dbg('CLICK navigateTo', iconInfo.xref, 'from=' + nodeId);
                            nav.navigateTo(iconInfo.xref);
                        }
                    });
                })(info, id);
            }
            this.iconCanvas.appendChild(btn);
        }
    }
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
    el.textContent = __('Expand children');

    var nav = this;
    el.addEventListener('click', function () {
        nav._dbg('CLICK expandLazy', node.id, 'fam=' + node.familyXref);
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
    var extraGap = spouseIndex > 0 ? spouseIndex * this.MULTI_SPOUSE_SEP : 0;
    return layout.x + this.CARD_W + this.COUPLE_GAP + spouseIndex * (this.CARD_W + this.COUPLE_GAP) + extraGap;
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

    function getFamilyAnchorX(nodeId, layout, familyIndex) {
        var node = self.nodeMap[nodeId];
        var wrapper = self.cardElements[nodeId];
        if (wrapper) {
            var wRect = wrapper.getBoundingClientRect();
            var cards = wrapper.querySelectorAll('.sp-card');
            var spouseCard = cards[familyIndex + 1];
            if (node && node.families && node.families.length > 1 && spouseCard) {
                var spouseRect = spouseCard.getBoundingClientRect();
                return snap(layout.x + ((spouseRect.left + spouseRect.width / 2) - wRect.left) / self.zoomLevel);
            }
            var lines = wrapper.querySelectorAll('.sp-couple-line');
            if (lines[familyIndex]) {
                var lineRect = lines[familyIndex].getBoundingClientRect();
                return snap(layout.x + ((lineRect.left + lineRect.width / 2) - wRect.left) / self.zoomLevel);
            }
        }

        if (node && node.families && node.families.length > 1) {
            return snap(self.getSpouseLeftX(layout, familyIndex) + self.CARD_W / 2);
        }
        return snap(self.getCoupleLineCenterX(layout, familyIndex));
    }

    // Build shared drawing context for sub-methods
    var dc = { ctx: ctx, snap: snap, drawDot: drawDot, dpr: dpr, snapOffsetDev: snapOffsetDev, R: R, getFamilyAnchorX: getFamilyAnchorX };

    var staggeredOffsets = this._drawPartnerConnectors(dc);
    this._drawChildForks(dc, staggeredOffsets);
};

/**
 * Draw horizontal partner/spouse connectors and vertical couple drops.
 * Returns staggeredOffsets map: nodeId -> { familyIndex -> yOffset }.
 */
FamilyNavigator.prototype._drawPartnerConnectors = function (dc) {
    var ctx = dc.ctx, snap = dc.snap, drawDot = dc.drawDot;
    var staggeredOffsets = {};

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
                var dropX = dc.getFamilyAnchorX(nodeId, layout, fi);

                ctx.beginPath();
                ctx.moveTo(dropX, dropStartY);
                ctx.lineTo(dropX, dropEndY);
                ctx.stroke();
            }
        }
    }

    return staggeredOffsets;
};

/**
 * Draw parent-to-child fork connectors using staggeredOffsets from partner connectors.
 */
FamilyNavigator.prototype._drawChildForks = function (dc, staggeredOffsets) {
    var ctx = dc.ctx, snap = dc.snap, R = dc.R;
    var self = this;

    function coupleLineCenterX(nodeId, layout, fi) {
        return dc.getFamilyAnchorX(nodeId, layout, fi);
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

    function resolveSourceFamilyIndex(parentNode, edge) {
        if (!edge || !parentNode || !parentNode.families || parentNode.families.length === 0) {
            return null;
        }
        if (edge.familyIndex !== undefined && edge.familyIndex !== null) {
            return edge.familyIndex;
        }
        if (edge.familyXref) {
            for (var pfi = 0; pfi < parentNode.families.length; pfi++) {
                if (parentNode.families[pfi] && parentNode.families[pfi].familyXref === edge.familyXref) {
                    return pfi;
                }
            }
        }
        return null;
    }

    function targetXForChild(childId, edge) {
        var cLayout = self.layoutMap[childId];
        if (!cLayout || cLayout.x === undefined) return null;

        var childNode = self.nodeMap[childId];
        var tx = cLayout.centerX;
        var ty = cLayout.y;

        if (childNode && childNode.families && childNode.families.length > 0) {
            var wrapper = self.cardElements[childId];
            if (wrapper) {
                var wRect = wrapper.getBoundingClientRect();
                var cards = wrapper.querySelectorAll('.sp-card');

                if (edge && edge.lineIndex !== undefined) {
                    var explicitCardIndex = Math.max(0, edge.lineIndex);
                    var targetCard = cards[explicitCardIndex] || cards[0];
                    if (targetCard) {
                        var cardRect = targetCard.getBoundingClientRect();
                        tx = cLayout.x + ((cardRect.left + cardRect.width / 2) - wRect.left) / self.zoomLevel;
                    }
                } else {
                    var oxref = childNode.originalChildXref;
                    var targetCardIndex = 0;
                    if (oxref && childNode.families) {
                        for (var cfi = 0; cfi < childNode.families.length; cfi++) {
                            var cSpouse = childNode.families[cfi].spouse;
                            if (cSpouse && cSpouse.xref === oxref && cards[cfi + 1]) {
                                targetCardIndex = cfi + 1;
                                break;
                            }
                        }
                    }
                    var targetCard = cards[targetCardIndex] || cards[0];
                    if (targetCard) {
                        var cardRect = targetCard.getBoundingClientRect();
                        tx = cLayout.x + ((cardRect.left + cardRect.width / 2) - wRect.left) / self.zoomLevel;
                    }
                }
            }
        }
        return { x: tx, y: ty };
    }

    // Draw edges between parent and child nodes
    for (var parentId in this.childrenMap) {
        var children = this.getVisibleChildren(parentId);
        if (children.length === 0) continue;

        var pLayout = this.layoutMap[parentId];
        if (!pLayout || pLayout.x === undefined) continue;

        var pNode = this.nodeMap[parentId];
        var srcY = pLayout.y + pLayout.h;

        // Group children by the actual source family on the parent node.
        var familyGroups = {};
        var defaultGroup = [];

        for (var ci = 0; ci < children.length; ci++) {
            var childId = children[ci];
            var edgeKey = parentId + '->' + childId;
            var edge = this.edgeMap[edgeKey];
            var sourceFamilyIndex = resolveSourceFamilyIndex(pNode, edge);
            if (sourceFamilyIndex !== null) {
                if (!familyGroups[sourceFamilyIndex]) {
                    familyGroups[sourceFamilyIndex] = [];
                }
                familyGroups[sourceFamilyIndex].push({ childId: childId, edge: edge });
            } else {
                defaultGroup.push({ childId: childId, edge: edge });
            }
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
                    barRatio = Math.max(0.16, 0.30 - offsetIdx * 0.08);
                }
                this.drawFork(ctx, srcX, famSrcY, targets, R, barRatio, dc.dpr, dc.snapOffsetDev);
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
                this.drawFork(ctx, defSrcX, defSrcY, targets, R, undefined, dc.dpr, dc.snapOffsetDev);
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
    this._dbg('switchAncestorLine', nodeId, 'line=' + lineIndex);
    this.activeLines[nodeId] = lineIndex;
    this.measureAndRender();
    this.focusNode(nodeId);
};

/**
 * Collect all person/spouse xrefs currently in the tree.
 * Used to tell the server which people are already rendered.
 */
FamilyNavigator.prototype._getKnownXrefs = function () {
    var xrefs = {};
    for (var id in this.nodeMap) {
        var n = this.nodeMap[id];
        if (n.person && n.person.xref) xrefs[n.person.xref] = true;
        if (n.families) {
            for (var fi = 0; fi < n.families.length; fi++) {
                var sp = n.families[fi].spouse;
                if (sp && sp.xref) xrefs[sp.xref] = true;
            }
        }
    }
    return Object.keys(xrefs).join(',');
};

/**
 * Expand ancestor branch in-place — fetch and merge ancestor data
 * without rebasing the whole tree.
 */
FamilyNavigator.prototype.expandAncestorInPlace = function (childNodeId, familyXref, childXref, lineIndex) {
    var nav = this;

    this._dbg('expandAncestorInPlace', childNodeId, 'fam=' + familyXref, 'child=' + childXref, 'line=' + lineIndex);

    // If ancestors for this exact line/family are already loaded (but hidden), just switch to them.
    var existingEdges = this.parentEdges[childNodeId] || [];
    for (var i = 0; i < existingEdges.length; i++) {
        var existingEdge = existingEdges[i];
        if (existingEdge.lineIndex === lineIndex && existingEdge.familyXref === familyXref) {
            this._dbg('expandAncestorInPlace → already loaded, switching line');
            this.activeLines[childNodeId] = lineIndex;
            this.measureAndRender();
            this.focusNode(childNodeId);
            return;
        }
    }

    var childNode = this.nodeMap[childNodeId];
    var childGen = (childNode && childNode.generation !== undefined) ? childNode.generation : 0;

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(familyXref)
        + '&pid=' + encodeURIComponent(childXref)
        + '&gen=' + encodeURIComponent(childGen + 1)
        + '&known=' + encodeURIComponent(this._getKnownXrefs());

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 30000;
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        nav._dbg('expandAncestorInPlace → received', newData.nodes.length, 'nodes, rootId=' + newData.rootId);
                        nav._expansionHistory.push({ type: 'ancestor', fid: familyXref, pid: childXref, lineIndex: lineIndex });
                        nav._mergeAncestorData(childNodeId, newData, lineIndex, familyXref);
                    }
                } catch (e) {
                    console.error('SP Tree Explorer: ancestor expand parse error', e);
                }
            } else if (xhr.status !== 0) {
                console.error('SP Tree Explorer: ancestor expand HTTP', xhr.status);
            }
        }
    };
    xhr.ontimeout = function () {
        nav.showLoader(false);
        console.error('SP Tree Explorer: ancestor expand request timed out');
    };
    xhr.send();
};

/**
 * Merge fetched ancestor data into the existing tree, connecting
 * the new subtree root to the given child node.
 */
FamilyNavigator.prototype._mergeAncestorData = function (childNodeId, newData, lineIndex, familyXref) {
    this._dbg('_mergeAncestorData', childNodeId, 'rootId=' + newData.rootId, 'line=' + lineIndex,
        'nodes=' + newData.nodes.length, 'edges=' + (newData.edges ? newData.edges.length : 0),
        'parentEdgesBefore=' + (this.parentEdges[childNodeId] ? this.parentEdges[childNodeId].length : 0));
    // Add new nodes
    for (var i = 0; i < newData.nodes.length; i++) {
        var n = newData.nodes[i];
        this.nodeMap[n.id] = n;
    }

    // Add new edges to edgeMap
    if (newData.edges) {
        for (var i = 0; i < newData.edges.length; i++) {
            var edge = newData.edges[i];
            this.edgeMap[edge.from + '->' + edge.to] = edge;
        }
    }

    // Connect the new subtree root to the existing child node
    if (newData.rootId) {
        var connectEdge = {
            from: newData.rootId,
            to: childNodeId,
            type: 'parent-child',
            line: lineIndex === 0 ? 'self' : 'spouse',
            lineIndex: lineIndex,
            familyXref: familyXref || ''
        };
        var connectKey = newData.rootId + '->' + childNodeId;
        this.edgeMap[connectKey] = connectEdge;

        this._dbg('_mergeAncestorData connect', connectKey);
    }

    // Full rebuild of childrenMap / parentEdges from edgeMap (with sorting)
    // to guarantee consistent state — avoids duplicate entries from
    // successive ancestor expansions.
    this._rebuildRelationships();

    // Mark that this child now has multiple ancestor lines
    if (newData.rootId) {
        var childNode = this.nodeMap[childNodeId];
        if (childNode) {
            var lineIndices = {};
            var pe = this.parentEdges[childNodeId] || [];
            for (var ei = 0; ei < pe.length; ei++) {
                if (pe[ei].lineIndex !== undefined) lineIndices[pe[ei].lineIndex] = true;
            }
            if (Object.keys(lineIndices).length > 1) {
                childNode.hasMultipleAncestorLines = true;
            }
        }

        this._dbg('_mergeAncestorData connect',
            newData.rootId + '->' + childNodeId,
            'parentEdgesAfter=' + (this.parentEdges[childNodeId] ? this.parentEdges[childNodeId].length : 0));
    }

    // Switch to the newly expanded ancestor line so it becomes visible
    if (lineIndex > 0) {
        this.activeLines[childNodeId] = lineIndex;
    }

    // Dump structure for debugging
    this._dbg('STRUCTURE after merge', 'child=' + childNodeId, JSON.stringify({
        child: (function(n) { return { id: n.id, person: n.person.xref, swap: n.genderSwapped, gen: n.generation, oxref: n.originalChildXref, families: n.families ? n.families.length : 0 }; })(this.nodeMap[childNodeId]),
        parentEdges: (this.parentEdges[childNodeId] || []).map(function(e) { return { from: e.from, line: e.lineIndex, type: e.line }; }),
        childrenOf: Object.keys(this.childrenMap).filter(function(k) { return this.childrenMap[k].indexOf(childNodeId) >= 0; }.bind(this)).map(function(k) { var n = this.nodeMap[k]; return { id: k, person: n ? n.person.xref : '?', hasFam: n && n.families ? n.families.length : 0 }; }.bind(this))
    }));

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
    this._dbg('navigateTo', xref);

    var url = this.expandUrl
        .replace('action=NodeExpand', 'action=NavigateTo')
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&xref=' + encodeURIComponent(xref);

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 30000;
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        // Replace the entire tree
                        nav._dbg('navigateTo → received', newData.nodes.length, 'nodes, rootId=' + newData.rootId);
                        nav.treeData = newData;
                        nav.activeLines = {};
                        nav._expansionHistory = [];

                        // Update expandUrl to use the new rootXref so that
                        // subsequent AJAX calls use the correct session counter
                        nav.expandUrl = nav.expandUrl.replace(
                            /rootXref=[^&]*/,
                            'rootXref=' + encodeURIComponent(xref)
                        );

                        nav.buildIndex(newData);
                        nav._setCurrentXref(xref);
                        nav.measureAndRender();
                        nav.focusOrigin();
                        nav._updateFocusPersonBox();
                    }
                } catch (e) {
                    console.error('SP Tree Explorer: navigate parse error', e);
                }
            } else if (xhr.status !== 0) {
                console.error('SP Tree Explorer: navigateTo HTTP', xhr.status);
            }
        }
    };
    xhr.ontimeout = function () {
        nav.showLoader(false);
        console.error('SP Tree Explorer: navigateTo request timed out');
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

    var direction = node.direction || 'up';
    var fid = node.familyXref;
    var pid = direction === 'down' ? (node.personXref || '') : (node.childXref || node.familyXref);
    var lazyGen = (node.generation !== undefined) ? node.generation : 0;

    this._dbg('expandLazyNode', lazyNodeId, 'dir=' + direction, 'fid=' + fid, 'pid=' + pid, 'gen=' + lazyGen);

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(fid)
        + '&pid=' + encodeURIComponent(pid)
        + '&gen=' + encodeURIComponent(lazyGen)
        + '&dir=' + encodeURIComponent(direction)
        + '&known=' + encodeURIComponent(this._getKnownXrefs());

    this.showLoader(true);

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            nav.showLoader(false);
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if ((newData.nodes && newData.nodes.length > 0) || (newData.childRootIds && newData.childRootIds.length > 0)) {
                        nav._expansionHistory.push({ type: 'lazy', fid: fid, pid: pid, dir: direction });
                        nav.mergeLazyData(lazyNodeId, newData);
                    } else {
                        // Empty response — remove the lazy node silently
                        delete nav.nodeMap[lazyNodeId];
                        nav.measureAndRender();
                    }
                } catch (e) {
                    console.error('SP Tree Explorer: expand parse error', e);
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
 * Merge newly loaded subtree data, replacing a lazy placeholder.
 * Handles both ancestor (direction='up') and descendant (direction='down') placeholders.
 *
 * Strategy: modify nodeMap + edgeMap incrementally, then rebuild
 * childrenMap / parentEdges from edgeMap (with sorting) to guarantee
 * consistent state for the layout engine.
 */
FamilyNavigator.prototype.mergeLazyData = function (lazyNodeId, newData) {
    var lazyNode = this.nodeMap[lazyNodeId];
    var direction = (lazyNode && lazyNode.direction) || 'up';

    this._dbg('mergeLazyData', lazyNodeId, 'dir=' + direction, 'nodes=' + (newData.nodes ? newData.nodes.length : 0), 'rootId=' + newData.rootId);

    if (direction === 'down') {
        // ---- Descendant expansion ----
        // The lazy node is a child of some parent; find that parent first.
        var parentId = null;
        var oldEdge = null;
        var parentEdgeList = this.parentEdges[lazyNodeId] || [];
        if (parentEdgeList.length > 0) {
            parentId = parentEdgeList[0].from;
            oldEdge = this.edgeMap[parentId + '->' + lazyNodeId] || null;
        }

        // 1. Remove lazy node + its edge
        delete this.nodeMap[lazyNodeId];
        delete this.layoutMap[lazyNodeId];
        if (parentId) {
            delete this.edgeMap[parentId + '->' + lazyNodeId];
        }

        // 2. Add new nodes
        for (var i = 0; i < newData.nodes.length; i++) {
            this.nodeMap[newData.nodes[i].id] = newData.nodes[i];
        }

        // 3. Add new internal edges (within each child subtree)
        for (var i = 0; i < newData.edges.length; i++) {
            var edge = newData.edges[i];
            this.edgeMap[edge.from + '->' + edge.to] = edge;
        }

        // 4. Create parent → child-root edges (preserving familyIndex)
        if (parentId && newData.childRootIds) {
            var familyIndex = (oldEdge && oldEdge.familyIndex !== undefined) ? oldEdge.familyIndex : 0;
            for (var i = 0; i < newData.childRootIds.length; i++) {
                var crid = newData.childRootIds[i];
                this.edgeMap[parentId + '->' + crid] = {
                    from: parentId,
                    to: crid,
                    type: 'parent-child',
                    familyIndex: familyIndex
                };
            }
        }

        // 5. Full rebuild of childrenMap / parentEdges (with sorting)
        this._rebuildRelationships();

        this.measureAndRender();
        this.focusNode(parentId || (newData.childRootIds && newData.childRootIds.length > 0 ? newData.childRootIds[0] : null));
    } else {
        // ---- Ancestor expansion (direction='up') ----
        // The lazy node IS the parent; find its child.
        var oldEdge = null;
        var childId = null;
        if (this.childrenMap[lazyNodeId] && this.childrenMap[lazyNodeId].length > 0) {
            childId = this.childrenMap[lazyNodeId][0];
            oldEdge = this.edgeMap[lazyNodeId + '->' + childId] || null;
        }
        var parentId = childId;

        // 1. Remove lazy node + its edge
        delete this.nodeMap[lazyNodeId];
        delete this.layoutMap[lazyNodeId];
        if (parentId) {
            delete this.edgeMap[lazyNodeId + '->' + parentId];
        }

        // 2. Add new nodes
        for (var i = 0; i < newData.nodes.length; i++) {
            this.nodeMap[newData.nodes[i].id] = newData.nodes[i];
        }

        // 3. Add new internal edges
        for (var i = 0; i < newData.edges.length; i++) {
            var edge = newData.edges[i];
            this.edgeMap[edge.from + '->' + edge.to] = edge;
        }

        // 4. Connect new ancestor root to the existing child
        if (parentId && newData.rootId) {
            var newEdge = {
                from: newData.rootId,
                to: parentId,
                type: 'parent-child'
            };
            if (oldEdge && oldEdge.lineIndex !== undefined) {
                newEdge.lineIndex = oldEdge.lineIndex;
                newEdge.line = oldEdge.line;
            }
            this.edgeMap[newData.rootId + '->' + parentId] = newEdge;
        }

        // 5. Full rebuild of childrenMap / parentEdges (with sorting)
        this._rebuildRelationships();

        this.measureAndRender();
        this.focusNode(parentId || newData.rootId);
    }
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

    this._onMouseMove = function (e) {
        if (!isDown) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging = true;
        if (!dragging) return;
        e.preventDefault();
        nav.panX = startPanX + dx;
        nav.panY = startPanY + dy;
        nav.applyTransform();
    };
    document.addEventListener('mousemove', this._onMouseMove);

    this._onMouseUp = function (e) {
        if (dragging) e.preventDefault();
        isDown = false;
        dragging = false;
        if (nav.container) nav.container.style.cursor = '';
    };
    document.addEventListener('mouseup', this._onMouseUp);

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

    this._onTouchMove = function (e) {
        if (!isDown || e.touches.length !== 1) return;
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging = true;
        if (!dragging) return;
        nav.panX = startPanX + dx;
        nav.panY = startPanY + dy;
        nav.applyTransform();
    };
    document.addEventListener('touchmove', this._onTouchMove, { passive: true });

    this._onTouchEnd = function () {
        isDown = false;
        dragging = false;
    };
    document.addEventListener('touchend', this._onTouchEnd);

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

    var btnOpenPage = document.getElementById(prefix + '_btnOpenPage');
    if (btnOpenPage) {
        btnOpenPage.addEventListener('click', function () {
            nav.openFullPage();
        });
    }

    var btnHome = document.getElementById(prefix + '_btnHome');
    if (btnHome) {
        btnHome.addEventListener('click', function () {
            nav.focusOrigin();
        });
    }

    // Store button refs for enabling/disabling
    this._toolbarButtons = {
        zoomIn:     document.getElementById(prefix + '_btnZoomIn'),
        zoomOut:    btnZoomOut,
        zoomReset:  btnZoomReset,
        fullscreen: btnFullscreen,
        share:      btnShare || btnOpenPage
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

    // Details toggle
    var toggleDetails = document.getElementById(prefix + '_toggleDetails');
    if (toggleDetails) {
        toggleDetails.checked = nav.showDetails;
        toggleDetails.addEventListener('change', function () {
            nav.showDetails = this.checked;
            nav._applyToggleClasses();
            nav.measureAndRender();
        });
    }

    // Advanced controls toggle
    var toggleAdvanced = document.getElementById(prefix + '_toggleAdvanced');
    if (toggleAdvanced) {
        toggleAdvanced.checked = nav.showAdvancedControls;
        toggleAdvanced.addEventListener('change', function () {
            nav.showAdvancedControls = this.checked;
            nav._applyToggleClasses();
            nav.measureAndRender();
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
    this._onEscape = function (e) {
        if (e.key === 'Escape' && nav.searchPanel && nav.searchPanel.classList.contains('sp-search-panel-open')) {
            nav.closeSearchPanel();
        }
    };
    document.addEventListener('keydown', this._onEscape);

    // Close search panel on click outside
    this._onClickOutside = function (e) {
        if (nav.searchPanel && nav.searchPanel.classList.contains('sp-search-panel-open')) {
            if (!nav.searchPanel.contains(e.target) && (!nav.focusChip || !nav.focusChip.contains(e.target))) {
                nav.closeSearchPanel();
            }
        }
    };
    document.addEventListener('mousedown', this._onClickOutside);

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
                console.error('SP Tree Explorer: search parse error', e);
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
            noResult.textContent = __('No results found');
            this.searchResults.appendChild(noResult);
            this.searchResults.classList.add('sp-show');
        }
        return;
    }

    var nav = this;

    // Event delegation — single listener instead of per-item closures
    if (!this._searchResultsDelegated) {
        this._searchResultsDelegated = true;
        this.searchResults.addEventListener('click', function (e) {
            var item = e.target.closest('.sp-search-item[data-xref]');
            if (item && item.dataset.xref) {
                nav._navigateFromSearch(item.dataset.xref);
            }
        });
    }

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
        this.searchResults.appendChild(el);
    }

    this.searchResults.classList.add('sp-show');
};

/**
 * Set currentRootXref and activate spouse ancestor line if the target
 * person ended up as spouse due to gender swap.
 * @param {string|null} targetXref - the xref the user actually wanted to see
 */
FamilyNavigator.prototype._setCurrentXref = function (targetXref) {
    var rootNode = this.nodeMap[this.treeData.rootId];
    if (!rootNode || !rootNode.person) return;

    var desiredXref = targetXref || this.baseXref || rootNode.person.xref;

    // Default: root person's own xref
    this.currentRootXref = rootNode.person.xref;
    if (this.treeData && this.treeData.rootId) {
        this.activeLines[this.treeData.rootId] = 0;
    }

    // Check if the requested person ended up as spouse (gender swap)
    if (desiredXref && desiredXref !== rootNode.person.xref && rootNode.families) {
        for (var fi = 0; fi < rootNode.families.length; fi++) {
            if (rootNode.families[fi].spouse && rootNode.families[fi].spouse.xref === desiredXref) {
                this.currentRootXref = desiredXref;
                this.activeLines[this.treeData.rootId] = fi + 1;
                this._updateOriginHighlight();
                return;
            }
        }
    }

    this.currentRootXref = desiredXref || rootNode.person.xref;
    this._updateOriginHighlight();
};

/**
 * Build a URL for the current tree state.
 * Captures toggle states, zoom, viewport center, and expansion history.
 */
FamilyNavigator.prototype._buildStateUrl = function (baseUrl) {
    var url = new URL(baseUrl || window.location.href, window.location.href);

    if (this.currentRootXref) {
        url.searchParams.set('xref', this.currentRootXref);
    }

    // Toggle states — always explicit so recipient sees the exact same view.
    url.searchParams.set('sources', this.showSources ? '1' : '0');
    url.searchParams.set('details', this.showDetails ? '1' : '0');
    url.searchParams.set('advanced', this.showAdvancedControls ? '1' : '0');

    // Zoom level
    url.searchParams.set('z', this.zoomLevel.toFixed(2));

    // Viewport center in tree coordinates (screen-size independent)
    if (this.container) {
        var wrapRect = this.container.getBoundingClientRect();
        var cx = (wrapRect.width / 2 - this.panX) / this.zoomLevel;
        var cy = (wrapRect.height / 2 - this.panY) / this.zoomLevel;
        url.searchParams.set('cx', Math.round(cx));
        url.searchParams.set('cy', Math.round(cy));
    }

    // Expansion history — lazy expansions
    var lazyParts = [];
    var ancParts = [];
    for (var i = 0; i < this._expansionHistory.length; i++) {
        var h = this._expansionHistory[i];
        if (h.type === 'lazy') {
            lazyParts.push(h.fid + '.' + h.pid + '.' + (h.dir || 'up'));
        } else if (h.type === 'ancestor') {
            ancParts.push(h.fid + '.' + h.pid + '.' + h.lineIndex);
        }
    }
    if (lazyParts.length > 0) {
        url.searchParams.set('exp', lazyParts.join(','));
    } else {
        url.searchParams.delete('exp');
    }
    if (ancParts.length > 0) {
        url.searchParams.set('anc', ancParts.join(','));
    } else {
        url.searchParams.delete('anc');
    }

    return url;
};

/**
 * Open the current tree in the standalone full-page chart view.
 */
FamilyNavigator.prototype.openFullPage = function () {
    if (!this.fullPageUrl) return;

    var targetUrl = this._buildStateUrl(this.fullPageUrl).toString();
    var opened = window.open(targetUrl, '_blank', 'noopener');
    if (!opened) {
        window.location.href = targetUrl;
    }
};

/**
 * Build a shareable URL for the current tree view and copy it to clipboard.
 */
FamilyNavigator.prototype.copyShareLink = function (btnEl) {
    var shareUrl = this._buildStateUrl(window.location.href).toString();

    navigator.clipboard.writeText(shareUrl).then(function () {
        // Brief visual feedback — swap icon to checkmark
        var original = btnEl.innerHTML;
        btnEl.innerHTML = '&#x2705;';
        setTimeout(function () { btnEl.innerHTML = original; }, 1500);
    }).catch(function () {
        // Fallback for older browsers / non-HTTPS
        try {
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
        } catch (e) {
            console.warn('SP Tree Explorer: clipboard copy failed', e);
        }
    });
};

// ==========================================================================
// FOCUS / CENTER
// ==========================================================================

FamilyNavigator.prototype.focusOrigin = function () {
    this.focusNode(this.treeData.rootId, this.currentRootXref || null);
};

FamilyNavigator.prototype._getNodeFocusPoint = function (nodeId, targetXref) {
    var layout = this.layoutMap[nodeId];
    if (!layout) return null;

    var fallback = {
        x: layout.centerX,
        y: layout.y + layout.h / 2
    };

    if (!targetXref) {
        return fallback;
    }

    var node = this.nodeMap[nodeId];
    var wrapper = this.cardElements[nodeId];
    if (!node || !wrapper) {
        return fallback;
    }

    var cards = wrapper.querySelectorAll('.sp-card');
    if (!cards || cards.length === 0) {
        return fallback;
    }

    var cardIndex = -1;
    if (node.person && node.person.xref === targetXref) {
        cardIndex = 0;
    } else if (node.families) {
        for (var fi = 0; fi < node.families.length; fi++) {
            if (node.families[fi].spouse && node.families[fi].spouse.xref === targetXref) {
                cardIndex = fi + 1;
                break;
            }
        }
    }

    if (cardIndex < 0 || !cards[cardIndex]) {
        return fallback;
    }

    var wRect = wrapper.getBoundingClientRect();
    var cRect = cards[cardIndex].getBoundingClientRect();

    return {
        x: layout.x + ((cRect.left + cRect.width / 2) - wRect.left) / this.zoomLevel,
        y: layout.y + ((cRect.top + cRect.height / 2) - wRect.top) / this.zoomLevel
    };
};

/**
 * Center the viewport on a specific node.
 */
FamilyNavigator.prototype.focusNode = function (nodeId, focusXref) {
    if (!this.container) return;

    var point = this._getNodeFocusPoint(nodeId, focusXref);
    if (!point) return;

    var wrapRect = this.container.getBoundingClientRect();

    var targetX = point.x * this.zoomLevel;
    var targetY = point.y * this.zoomLevel;

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
        this.focusName.textContent = __('Search person\u2026');
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

/**
 * Apply or remove CSS classes on the container for details/advanced toggles.
 */
FamilyNavigator.prototype._applyToggleClasses = function () {
    var container = this.container;
    if (!container) return;
    container.classList.toggle('sp-hide-details', !this.showDetails);
    container.classList.toggle('sp-hide-advanced', !this.showAdvancedControls);
};

/**
 * Restore viewport to a specific zoom level and tree-coordinate center.
 */
FamilyNavigator.prototype._restoreViewState = function (zoom, cx, cy) {
    if (!this.container) return;
    this.zoomLevel = Math.min(this.zoomMax, Math.max(this.zoomMin, zoom));
    var wrapRect = this.container.getBoundingClientRect();
    this.panX = wrapRect.width / 2 - cx * this.zoomLevel;
    this.panY = wrapRect.height / 2 - cy * this.zoomLevel;
    this.applyTransform();
};

/**
 * Replay expansion history from URL params (sequential AJAX).
 * @param {string[]} expList  - lazy expansions as "fid.pid" strings
 * @param {string[]} ancList  - ancestor expansions as "fid.pid.lineIndex" strings
 * @param {function} callback - called when all expansions are done
 */
FamilyNavigator.prototype._replayExpansions = function (expList, ancList, callback) {
    var nav = this;
    var queue = [];

    // Build ordered queue: lazy first, then ancestors
    for (var i = 0; i < expList.length; i++) {
        var parts = expList[i].split('.');
        if (parts.length >= 2) {
            queue.push({ type: 'lazy', fid: parts[0], pid: parts[1], dir: parts[2] || 'up' });
        }
    }
    for (var i = 0; i < ancList.length; i++) {
        var parts = ancList[i].split('.');
        if (parts.length >= 3) {
            queue.push({ type: 'ancestor', fid: parts[0], pid: parts[1], lineIndex: parseInt(parts[2], 10) });
        }
    }

    if (queue.length === 0) {
        callback();
        return;
    }

    nav.showLoader(true);

    function processNext(idx) {
        if (idx >= queue.length) {
            nav.showLoader(false);
            callback();
            return;
        }

        var item = queue[idx];
        if (item.type === 'lazy') {
            nav._replayLazyExpand(item.fid, item.pid, item.dir, function () {
                processNext(idx + 1);
            });
        } else {
            nav._replayAncestorExpand(item.fid, item.pid, item.lineIndex, function () {
                processNext(idx + 1);
            });
        }
    }

    processNext(0);
};

/**
 * Find and expand a lazy node matching the given family/person xrefs.
 */
FamilyNavigator.prototype._replayLazyExpand = function (fid, pid, dir, callback) {
    var nav = this;
    var direction = dir || 'up';

    // Find the lazy node with matching familyXref
    var lazyNodeId = null;
    for (var id in this.nodeMap) {
        var n = this.nodeMap[id];
        if (n.type === 'lazy' && n.familyXref === fid) {
            lazyNodeId = id;
            break;
        }
    }

    if (!lazyNodeId) {
        callback();
        return;
    }

    var lazyNode = this.nodeMap[lazyNodeId];
    var lazyGen = (lazyNode && lazyNode.generation !== undefined) ? lazyNode.generation : 0;

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(fid)
        + '&pid=' + encodeURIComponent(pid)
        + '&gen=' + encodeURIComponent(lazyGen)
        + '&dir=' + encodeURIComponent(direction)
        + '&known=' + encodeURIComponent(this._getKnownXrefs());

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if ((newData.nodes && newData.nodes.length > 0) || (newData.childRootIds && newData.childRootIds.length > 0)) {
                        nav._expansionHistory.push({ type: 'lazy', fid: fid, pid: pid, dir: direction });
                        nav.mergeLazyData(lazyNodeId, newData);
                    }
                } catch (e) {
                    console.error('SP Tree Explorer: replay lazy parse error', e);
                }
            }
            callback();
        }
    };
    xhr.send();
};

/**
 * Find and expand an ancestor branch matching the given family/person xrefs.
 */
FamilyNavigator.prototype._replayAncestorExpand = function (fid, pid, lineIndex, callback) {
    var nav = this;

    // Find the node whose person xref matches pid
    var childNodeId = null;
    for (var id in this.nodeMap) {
        var n = this.nodeMap[id];
        if (n.person && n.person.xref === pid) {
            childNodeId = id;
            break;
        }
    }

    if (!childNodeId) {
        callback();
        return;
    }

    // Check if already expanded for this line
    var existingEdges = this.parentEdges[childNodeId] || [];
    for (var i = 0; i < existingEdges.length; i++) {
        var existingEdge = existingEdges[i];
        if (existingEdge.lineIndex === lineIndex && existingEdge.familyXref === fid) {
            this.activeLines[childNodeId] = lineIndex;
            this.measureAndRender();
            callback();
            return;
        }
    }

    var childNode = this.nodeMap[childNodeId];
    var childGen = (childNode && childNode.generation !== undefined) ? childNode.generation : 0;

    var url = this.expandUrl
        + '&instance=' + encodeURIComponent(this.cardPrefix)
        + '&fid=' + encodeURIComponent(fid)
        + '&pid=' + encodeURIComponent(pid)
        + '&gen=' + encodeURIComponent(childGen + 1)
        + '&known=' + encodeURIComponent(this._getKnownXrefs());

    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            if (xhr.status === 200 && xhr.responseText) {
                try {
                    var newData = JSON.parse(xhr.responseText);
                    if (newData.nodes && newData.nodes.length > 0) {
                        nav._expansionHistory.push({ type: 'ancestor', fid: fid, pid: pid, lineIndex: lineIndex });
                        nav._mergeAncestorData(childNodeId, newData, lineIndex, fid);
                    }
                } catch (e) {
                    console.error('SP Tree Explorer: replay ancestor parse error', e);
                }
            }
            callback();
        }
    };
    xhr.send();
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

/**
 * Clean up all observers, document-level listeners, and detached DOM nodes.
 * Call before re-creating a FamilyNavigator on the same container.
 */
FamilyNavigator.prototype.destroy = function () {
    // ResizeObserver
    if (this._containerObserver) {
        this._containerObserver.disconnect();
        this._containerObserver = null;
    }
    // Document-level pan/zoom handlers
    if (this._onMouseMove)   document.removeEventListener('mousemove', this._onMouseMove);
    if (this._onMouseUp)     document.removeEventListener('mouseup', this._onMouseUp);
    if (this._onTouchMove)   document.removeEventListener('touchmove', this._onTouchMove);
    if (this._onTouchEnd)    document.removeEventListener('touchend', this._onTouchEnd);
    // Toolbar document handlers
    if (this._onEscape)      document.removeEventListener('keydown', this._onEscape);
    if (this._onClickOutside) document.removeEventListener('mousedown', this._onClickOutside);
    // Re-parent search panel back (or remove)
    if (this.searchPanel && this.searchPanel.parentNode === document.body) {
        this.searchPanel.parentNode.removeChild(this.searchPanel);
    }
    // Icon overlay cleanup
    if (this.iconOverlay && this.iconOverlay.parentNode) {
        this.iconOverlay.parentNode.removeChild(this.iconOverlay);
    }
};

