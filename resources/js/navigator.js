/**
 * SP Tree Explorer for webtrees
 * Family Navigator — JSON → Layout → Cards → Canvas connectors
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

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
    this.loaderIcon     = document.getElementById(cardPrefix + '_loader');
    this.toolbar        = document.getElementById(cardPrefix + '_toolbar');
    this.overlay        = document.getElementById(cardPrefix + '_overlay');
    this.searchInput    = document.getElementById(cardPrefix + '_searchInput');
    this.searchResults  = document.getElementById(cardPrefix + '_searchResults');
    this.btnGo          = document.getElementById(cardPrefix + '_btnGo');

    // Selected person xref from search
    this.selectedXref   = '';

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
    this.V_GAP          = 48;   // vertical gap between generations
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

    // DOM card references
    this.cardElements   = {};   // nodeId -> DOM element

    // Build indexes and render
    this.buildIndex(this.treeData);

    // Determine the actual target xref (may differ from root person due to gender swap)
    var urlXref = new URL(window.location.href).searchParams.get('xref');
    this._setCurrentXref(urlXref);

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
}

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
                childrenTotalW += this.H_GAP;
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
                childrenTotalW += this.H_GAP;
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
                gap += this.H_GAP;
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
        for (var fi = 0; fi < node.families.length; fi++) {
            var fam = node.families[fi];
            var lineEl = this.createCoupleLine(fam, node.id, fi);
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

    // Person card: show navigate icon when ancestors not visible above
    if (personHasParents && !personAncestorsVisible) {
        personCard.appendChild(this.createNavigateIcon(node.person.xref));
    }

    // Spouse cards: show navigate icon when spouse has parents not visible above
    for (var si = 0; si < spouseCards.length; si++) {
        var sc = spouseCards[si];
        if (sc.family.spouse && sc.family.spouseHasParents) {
            // Only first spouse (index 0) gets ancestor-line support for now
            if (si === 0 && spouseAncestorsVisible) continue;
            sc.card.appendChild(this.createNavigateIcon(sc.family.spouse.xref));
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

    // Avatar — clickable link to add-media page
    var avatarWrap = document.createElement('a');
    avatarWrap.className = 'sp-avatar-wrap';
    avatarWrap.href = personData.addMediaUrl;
    avatarWrap.target = '_blank';
    avatarWrap.title = 'Add photo';
    if (personData.thumb) {
        var img = document.createElement('img');
        img.className = 'sp-avatar';
        img.src = personData.thumb;
        img.alt = personData.name;
        img.loading = 'lazy';
        avatarWrap.appendChild(img);
    } else {
        // Gender-based silhouette placeholder
        var silClass = personData.sex === 'F' ? 'sp-silhouette-f' : (personData.sex === 'M' ? 'sp-silhouette-m' : 'sp-silhouette-u');
        avatarWrap.classList.add(silClass);
    }
    person.appendChild(avatarWrap);

    // Info (name + years)
    var info = document.createElement('div');
    info.className = 'sp-info';

    var nameLink = document.createElement('a');
    nameLink.className = 'sp-name';
    nameLink.href = personData.url;
    nameLink.target = '_blank';
    nameLink.textContent = personData.name;
    info.appendChild(nameLink);

    var years = document.createElement('span');
    years.className = 'sp-years';
    years.innerHTML = personData.years || '';
    info.appendChild(years);

    person.appendChild(info);
    card.appendChild(person);

    // Actions row
    var actions = document.createElement('div');
    actions.className = 'sp-card-actions';
    var viewLink = document.createElement('a');
    viewLink.href = personData.url;
    viewLink.innerHTML = '&#x270E;';
    actions.appendChild(viewLink);
    card.appendChild(actions);

    return card;
};

/**
 * Create couple-line element with marriage rings, dates, and optional divorce info.
 */
FamilyNavigator.prototype.createCoupleLine = function (familyData, nodeId, familyIndex) {
    var lineEl = document.createElement('div');
    lineEl.className = 'sp-couple-line';
    lineEl.dataset.familyIndex = familyIndex;

    // Add class for staggered positioning of multiple marriages
    if (familyIndex > 0) {
        lineEl.classList.add('sp-couple-line-alt');
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

    if (isDivorced) {
        // Divorced layout: top date / broken rings / bottom date.
        // Use explicit positions so long localized dates do not collide with connectors.
        lineEl.classList.add('sp-couple-line-divorced');
        lineEl.title = [
            familyData.marriageDate ? ('Marriage: ' + familyData.marriageDate) : '',
            familyData.divorceDate ? ('Divorce: ' + familyData.divorceDate) : ''
        ].filter(Boolean).join(' | ');

        if (familyData.marriageDate) {
            var mDate = document.createElement('span');
            mDate.className = 'sp-couple-date sp-couple-date-top';
            mDate.textContent = familyData.marriageDate;
            mDate.title = familyData.marriageDate;
            lineEl.appendChild(mDate);
        }

        var brokenRings = document.createElement('span');
        brokenRings.className = 'sp-couple-rings sp-rings-broken';
        brokenRings.innerHTML = '<svg viewBox="0 0 24 14" width="20" height="12"><circle cx="8" cy="7" r="5" fill="none" stroke="#ccc" stroke-width="1.5"/><circle cx="16" cy="7" r="5" fill="none" stroke="#ccc" stroke-width="1.5"/><line x1="4" y1="2" x2="20" y2="12" stroke="#e74c3c" stroke-width="1.5"/></svg>';
        lineEl.appendChild(brokenRings);

        if (familyData.divorceDate) {
            var dDate = document.createElement('span');
            dDate.className = 'sp-couple-date sp-divorce-date sp-couple-date-bottom';
            dDate.textContent = familyData.divorceDate;
            dDate.title = familyData.divorceDate;
            lineEl.appendChild(dDate);
        }
    } else if (isMarried) {
        // Married layout: rings + optional date
        var rings = document.createElement('span');
        rings.className = 'sp-couple-rings';
        rings.innerHTML = '<svg viewBox="0 0 24 14" width="20" height="12"><circle cx="8" cy="7" r="5" fill="none" stroke="#f9a8d4" stroke-width="1.5"/><circle cx="16" cy="7" r="5" fill="none" stroke="#67e8f9" stroke-width="1.5"/></svg>';
        lineEl.appendChild(rings);
        if (familyData.marriageDate) {
            var mDate = document.createElement('span');
            mDate.className = 'sp-couple-date';
            mDate.textContent = familyData.marriageDate;
            lineEl.appendChild(mDate);
        }
    } else {
        // Unmarried couple — heart icon, no rings
        var heart = document.createElement('span');
        heart.className = 'sp-couple-rings';
        heart.innerHTML = '<svg viewBox="0 0 20 18" width="16" height="14"><path d="M10 17s-7-4.35-7-10A4 4 0 0 1 10 4a4 4 0 0 1 7 3c0 5.65-7 10-7 10z" fill="none" stroke="#e8a0b8" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        lineEl.appendChild(heart);
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
 * Create a navigation icon — click to re-center the tree on this person.
 */
FamilyNavigator.prototype.createNavigateIcon = function (xref) {
    var nav = this;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-ancestor-tree-btn sp-ancestor-expand';
    btn.title = 'Navigate to this person';
    btn.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18">'
        + '<line x1="10" y1="20" x2="10" y2="7" stroke="currentColor" stroke-width="2"/>'
        + '<line x1="10" y1="9" x2="4" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        + '<line x1="10" y1="9" x2="16" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
        + '<circle cx="4" cy="3" r="2" fill="currentColor"/>'
        + '<circle cx="16" cy="3" r="2" fill="currentColor"/>'
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

    ctx.strokeStyle = '#c0c6d0';
    ctx.fillStyle = '#c0c6d0';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var R = 8; // corner radius for rounded connectors
    var dotRadius = 4; // Small circle radius at connection points
    var self = this;

    // Helper to draw a small filled circle
    function drawDot(x, y) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw couple connectors and dots
    // For first marriage: dots at person card edge and spouse card edge (CSS draws the horizontal line)
    // For subsequent marriages: draw canvas line from person to spouse, dots at endpoints
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
        
        // Get person card (first card) right edge position
        var personCard = allCards[0];
        var personCardRect = personCard ? personCard.getBoundingClientRect() : null;
        var personRightX = personCard ? layout.x + (personCardRect.right - wrapperRect.left) / this.zoomLevel : layout.x + this.CARD_W;
        
        // Get first marriage Y position (for drawing subsequent marriage starting point)
        var firstLineEl = coupleLines.length > 0 ? coupleLines[0] : null;
        var firstLineRect = firstLineEl ? firstLineEl.getBoundingClientRect() : null;
        var firstLineCenterY = firstLineRect 
            ? layout.y + ((firstLineRect.top + firstLineRect.height / 2) - wrapperRect.top) / this.zoomLevel
            : layout.y + layout.h / 2;
        
        for (var li = 0; li < coupleLines.length; li++) {
            var lineEl = coupleLines[li];
            var familyIndex = parseInt(lineEl.dataset.familyIndex) || 0;
            var lineRect = lineEl.getBoundingClientRect();
            var lineCenterY = layout.y + ((lineRect.top + lineRect.height / 2) - wrapperRect.top) / this.zoomLevel;
            
            // Get spouse card (follows the couple-line)
            var spouseCard = lineEl.nextElementSibling;
            var spouseLeftX;
            if (spouseCard && spouseCard.classList.contains('sp-card')) {
                var spouseRect = spouseCard.getBoundingClientRect();
                spouseLeftX = layout.x + (spouseRect.left - wrapperRect.left) / this.zoomLevel;
            } else {
                spouseLeftX = layout.x + (lineRect.right - wrapperRect.left) / this.zoomLevel;
            }
            
            if (familyIndex === 0) {
                // First marriage: CSS handles horizontal line, draw dots at card edges
                drawDot(personRightX, lineCenterY);
                drawDot(spouseLeftX, lineCenterY);
            } else {
                // Subsequent marriages: route through a dedicated lane so lines from
                // multiple families do not stack on the same bend point.
                var laneOffset = Math.min(10 + familyIndex * 4, 22);
                var laneX = Math.min(personRightX + laneOffset, spouseLeftX - 8);

                // Fallback if spouse is extremely close: keep old direct geometry.
                if (laneX <= personRightX + 2) {
                    laneX = personRightX + 2;
                }

                var r = Math.min(R, Math.abs(lineCenterY - firstLineCenterY), Math.abs(spouseLeftX - laneX), Math.abs(laneX - personRightX));
                ctx.beginPath();
                ctx.moveTo(personRightX, firstLineCenterY);
                ctx.lineTo(laneX - r, firstLineCenterY);
                if (r > 0) {
                    ctx.quadraticCurveTo(laneX, firstLineCenterY, laneX, firstLineCenterY + r);
                }
                ctx.lineTo(laneX, lineCenterY - r);
                if (r > 0) {
                    ctx.quadraticCurveTo(laneX, lineCenterY, laneX + r, lineCenterY);
                }
                ctx.lineTo(spouseLeftX, lineCenterY);
                ctx.stroke();
                
                // Draw dot only at spouse card edge (person edge dot shared with first marriage)
                drawDot(spouseLeftX, lineCenterY);
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

        // Helper: find the rendered center X of a couple-line element by familyIndex.
        // Falls back to a theoretical position when the DOM element is unavailable.
        var self = this;
        var wrapperRect = null; // Cache wrapper rect for performance
        
        function getWrapperRect(nodeId) {
            var wrapper = self.cardElements[nodeId];
            if (!wrapper) return null;
            return wrapper.getBoundingClientRect();
        }
        
        function coupleLineCenterX(nodeId, layout, fi) {
            var wrapper = self.cardElements[nodeId];
            if (wrapper) {
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                for (var li = 0; li < lines.length; li++) {
                    if (parseInt(lines[li].dataset.familyIndex) === fi) {
                        return layout.x + lines[li].offsetLeft + lines[li].offsetWidth / 2;
                    }
                }
            }
            // Fallback: theoretical position
            return layout.x + self.CARD_W + fi * (self.COUPLE_GAP + self.CARD_W) + self.COUPLE_GAP / 2;
        }

        // Helper: find the bottom Y of a couple-line element for connector source
        // Uses getBoundingClientRect to correctly handle margins
        function coupleLineBottomY(nodeId, layout, fi) {
            var wrapper = self.cardElements[nodeId];
            if (wrapper) {
                var wRect = wrapper.getBoundingClientRect();
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                for (var li = 0; li < lines.length; li++) {
                    if (parseInt(lines[li].dataset.familyIndex) === fi) {
                        var lineRect = lines[li].getBoundingClientRect();
                        // Convert from viewport coords to canvas coords
                        var relativeBottom = (lineRect.bottom - wRect.top) / self.zoomLevel;
                        return layout.y + relativeBottom;
                    }
                }
            }
            // Fallback
            return layout.y + layout.h;
        }

        // Helper: find the rendered center X of a spouse card (right side) for
        // a child node.  The person card is always first (offsetLeft ≈ 0), so
        // its center never needs DOM lookup.
        function spouseCardCenterX(nodeId, layout, spouseFI) {
            var wrapper = self.cardElements[nodeId];
            if (wrapper) {
                // Spouse card follows its couple-line.  Find the couple-line
                // for spouseFI, then take the next element sibling (the card).
                var lines = wrapper.querySelectorAll('.sp-couple-line');
                for (var li = 0; li < lines.length; li++) {
                    if (parseInt(lines[li].dataset.familyIndex) === spouseFI) {
                        var sCard = lines[li].nextElementSibling;
                        if (sCard) {
                            return layout.x + sCard.offsetLeft + sCard.offsetWidth / 2;
                        }
                    }
                }
            }
            // Fallback
            return layout.x + self.CARD_W + (spouseFI + 1) * (self.COUPLE_GAP + self.CARD_W) - self.CARD_W / 2;
        }

        // Helper: compute target X for a child node
        function targetXForChild(childId, edge) {
            var cLayout = self.layoutMap[childId];
            if (!cLayout || cLayout.x === undefined) return null;
            var childNode = self.nodeMap[childId];
            var tx = cLayout.centerX;
            if (childNode && childNode.families && childNode.families.length > 0) {
                if (edge && edge.lineIndex !== undefined) {
                    if (edge.lineIndex === 1) {
                        tx = spouseCardCenterX(childId, cLayout, 0);
                    } else {
                        tx = cLayout.x + self.CARD_W / 2;
                    }
                } else {
                    var oxref = childNode.originalChildXref;
                    var cFirstSpouse = childNode.families[0].spouse;
                    if (oxref && cFirstSpouse && cFirstSpouse.xref === oxref) {
                        tx = spouseCardCenterX(childId, cLayout, 0);
                    } else {
                        tx = cLayout.x + self.CARD_W / 2;
                    }
                }
            }
            return { x: tx, y: cLayout.y };
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

        // Draw forks per family group — stagger bar heights so they don't overlap
        var familyKeys = Object.keys(familyGroups);
        var familyGroupCount = familyKeys.length;
        for (var fki = 0; fki < familyKeys.length; fki++) {
            var fi = parseInt(familyKeys[fki]);
            var items = familyGroups[fi];
            var srcX = coupleLineCenterX(parentId, pLayout, fi);
            var famSrcY = coupleLineBottomY(parentId, pLayout, fi);
            var targets = [];
            for (var gi = 0; gi < items.length; gi++) {
                var t = targetXForChild(items[gi].childId, items[gi].edge);
                if (t) targets.push(t);
            }
            if (targets.length > 0) {
                // Stagger bar Y so forks from different families don't overlap.
                // Spread evenly between 0.2 and 0.8 of the vertical gap.
                var barRatio = familyGroupCount > 1
                    ? 0.2 + (fki / (familyGroupCount - 1)) * 0.6
                    : 0.5;
                this.drawFork(ctx, srcX, famSrcY, targets, R, barRatio);
            }
        }

        // Draw default group (ancestor edges, etc.) from first couple-line center or card center
        if (defaultGroup.length > 0) {
            var defSrcX;
            var defSrcY;
            if (pNode && pNode.families && pNode.families.length > 0) {
                defSrcX = coupleLineCenterX(parentId, pLayout, 0);
                defSrcY = coupleLineBottomY(parentId, pLayout, 0);
            } else {
                defSrcX = pLayout.centerX;
                defSrcY = srcY;
            }
            var targets = [];
            for (var gi = 0; gi < defaultGroup.length; gi++) {
                var t = targetXForChild(defaultGroup[gi].childId, defaultGroup[gi].edge);
                if (t) targets.push(t);
            }
            if (targets.length > 0) {
                this.drawFork(ctx, defSrcX, defSrcY, targets, R);
            }
        }
    }
};

/**
 * Draw a fork connector: one source at top, branching down to multiple targets.
 * Uses rounded corners for a polished look.
 */
FamilyNavigator.prototype.drawFork = function (ctx, srcX, srcY, targets, R, barYRatio) {
    if (targets.length === 0) return;
    if (barYRatio === undefined) barYRatio = 0.5;

    var dotRadius = 4; // Small circle radius at connection points

    // Bar Y = positioned between source bottom and nearest target top
    var nearestY = targets[0].y;
    for (var i = 1; i < targets.length; i++) {
        if (targets[i].y < nearestY) nearestY = targets[i].y;
    }
    var barY = Math.round(srcY + (nearestY - srcY) * barYRatio);

    // Helper: draw a small filled circle
    function drawDot(x, y) {
        ctx.beginPath();
        ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        ctx.fill();
    }

    // Single child directly below — straight line
    if (targets.length === 1 && Math.abs(targets[0].x - srcX) < 2) {
        ctx.beginPath();
        ctx.moveTo(srcX, srcY);
        ctx.lineTo(srcX, targets[0].y);
        ctx.stroke();
        drawDot(srcX, targets[0].y);
        return;
    }

    // Single child offset — L-shape with rounded corner
    if (targets.length === 1) {
        var tx = targets[0].x;
        var ty = targets[0].y;
        var dir = tx > srcX ? 1 : -1;
        var r = Math.min(R, Math.abs(tx - srcX), Math.abs(barY - srcY), Math.abs(ty - barY));
        // Keep corner visibly rounded whenever there is enough room.
        if (Math.abs(tx - srcX) > 6 && Math.abs(barY - srcY) > 6 && Math.abs(ty - barY) > 6) {
            r = Math.max(2, r);
        }

        ctx.beginPath();
        ctx.moveTo(srcX, srcY);
        ctx.lineTo(srcX, barY - r);
        ctx.quadraticCurveTo(srcX, barY, srcX + dir * r, barY);
        ctx.lineTo(tx - dir * r, barY);
        ctx.quadraticCurveTo(tx, barY, tx, barY + r);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        drawDot(tx, ty);
        return;
    }

    // Multiple children — draw one shared fork (trunk + bar + drops).
    // This avoids re-drawing overlapping paths for each child, which can
    // look like "spaghetti" on dense trees with multiple families.
    targets.sort(function (a, b) { return a.x - b.x; });
    var minX = targets[0].x;
    var maxX = targets[targets.length - 1].x;

    // Ensure horizontal bar always intersects the source trunk.
    if (srcX < minX) minX = srcX;
    if (srcX > maxX) maxX = srcX;

    // Shared vertical trunk from source to bar
    ctx.beginPath();
    ctx.moveTo(srcX, srcY);
    ctx.lineTo(srcX, barY);
    ctx.stroke();

    // Shared horizontal fork bar
    ctx.beginPath();
    ctx.moveTo(minX, barY);
    ctx.lineTo(maxX, barY);
    ctx.stroke();

    // Individual drops to each child with rounded elbow from fork bar.
    // This keeps child connectors visually consistent with rounded style.
    for (var i = 0; i < targets.length; i++) {
        var tx = targets[i].x;
        var ty = targets[i].y;
        var dx = tx - srcX;
        var absDx = Math.abs(dx);
        var elbow = Math.min(R, Math.floor(absDx / 2), Math.max(0, ty - barY));

        ctx.beginPath();
        if (absDx < 2 || elbow < 2) {
            // Near-vertical branch: straight drop.
            ctx.moveTo(tx, barY);
            ctx.lineTo(tx, ty);
        } else {
            var dir = dx > 0 ? 1 : -1;
            // Approach from the bar, round into the vertical drop.
            ctx.moveTo(tx - dir * elbow, barY);
            ctx.quadraticCurveTo(tx, barY, tx, barY + elbow);
            ctx.lineTo(tx, ty);
        }
        ctx.stroke();
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
    var transformStr = 'translate(' + this.panX + 'px, ' + this.panY + 'px) scale(' + this.zoomLevel + ')';
    if (this.canvas) {
        this.canvas.style.transform = transformStr;
    }
    if (this.connCanvas) {
        this.connCanvas.style.transform = transformStr;
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

    var btnExport = document.getElementById(prefix + '_btnExport');
    if (btnExport) {
        btnExport.addEventListener('click', function () {
            nav.exportPng();
        });
    }

    var btnShare = document.getElementById(prefix + '_btnShare');
    if (btnShare) {
        btnShare.addEventListener('click', function () {
            nav.copyShareLink(btnShare);
        });
    }
};

// ==========================================================================
// SEARCH — person autocomplete and navigation
// ==========================================================================

FamilyNavigator.prototype.initSearch = function () {
    var nav = this;
    var searchTimeout = null;

    if (!this.searchInput || !this.searchResults || !this.btnGo) return;

    // Input handler with debounce
    this.searchInput.addEventListener('input', function () {
        var query = nav.searchInput.value.trim();
        nav.selectedXref = '';
        nav.btnGo.disabled = true;

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

    // Close dropdown when clicking outside
    document.addEventListener('click', function (e) {
        if (!nav.searchInput.contains(e.target) && !nav.searchResults.contains(e.target)) {
            nav.searchResults.classList.remove('sp-show');
        }
    });

    // Focus input shows results if available
    this.searchInput.addEventListener('focus', function () {
        if (nav.searchResults.children.length > 0) {
            nav.searchResults.classList.add('sp-show');
        }
    });

    // Go button handler
    this.btnGo.addEventListener('click', function () {
        if (nav.selectedXref) {
            nav.searchResults.classList.remove('sp-show');
            nav.navigateTo(nav.selectedXref);
            nav.searchInput.value = '';
            nav.selectedXref = '';
            nav.btnGo.disabled = true;
        }
    });

    // Enter key in search input
    this.searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && nav.selectedXref) {
            e.preventDefault();
            nav.btnGo.click();
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
                var results = JSON.parse(xhr.responseText);
                nav.renderSearchResults(results);
            } catch (e) {
                console.error('SP Tree Navigator: search parse error', e);
            }
        }
    };
    xhr.send();
};

FamilyNavigator.prototype.renderSearchResults = function (results) {
    var nav = this;
    this.searchResults.innerHTML = '';

    if (results.length === 0) {
        var noResult = document.createElement('div');
        noResult.className = 'sp-search-item sp-no-result';
        noResult.textContent = 'No results found';
        this.searchResults.appendChild(noResult);
        this.searchResults.classList.add('sp-show');
        return;
    }

    for (var i = 0; i < results.length; i++) {
        var item = results[i];
        var div = document.createElement('div');
        div.className = 'sp-search-item';
        div.dataset.xref = item.xref;
        div.innerHTML = '<span class="sp-search-name">' + this._escapeHtml(item.name) + '</span>' +
                        '<span class="sp-search-years">' + this._escapeHtml(item.years || '') + '</span>';

        div.addEventListener('click', (function (xref, name) {
            return function () {
                nav.selectedXref = xref;
                nav.searchInput.value = name;
                nav.btnGo.disabled = false;
                nav.searchResults.classList.remove('sp-show');
            };
        })(item.xref, item.name));

        this.searchResults.appendChild(div);
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
// FULLSCREEN
// ==========================================================================

FamilyNavigator.prototype.toggleFullscreen = function () {
    var wrap = this.container;
    if (!wrap) return;
    var chartParent = wrap.closest('.wt-chart-interactive');
    if (chartParent) {
        chartParent.classList.toggle('sp-fullview');
    }
    setTimeout(function () {
        // Re-center after the resize
    }, 100);
};

// ==========================================================================
// PNG EXPORT
// ==========================================================================

FamilyNavigator.prototype.exportPng = function () {
    var nav = this;
    if (!this.canvas || !this.connCanvas) return;

    nav.showLoader(true);

    // Calculate bounds from layout
    var maxX = 0, maxY = 0;
    for (var id in this.layoutMap) {
        var l = this.layoutMap[id];
        if (l.x !== undefined) {
            if (l.x + l.w > maxX) maxX = l.x + l.w;
            if (l.y + l.h > maxY) maxY = l.y + l.h;
        }
    }
    var exportW = maxX + 80;
    var exportH = maxY + 80;

    // Create an offscreen canvas for compositing
    var offscreen = document.createElement('canvas');
    var dpr = 2; // Export at 2x for quality
    offscreen.width = exportW * dpr;
    offscreen.height = exportH * dpr;
    var offCtx = offscreen.getContext('2d');
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fill background
    offCtx.fillStyle = '#f8f9fb';
    offCtx.fillRect(0, 0, exportW, exportH);

    // Draw connector lines from our connCanvas
    offCtx.drawImage(this.connCanvas, 0, 0, exportW, exportH);

    // Use html2canvas to capture the cards layer
    if (typeof html2canvas !== 'undefined') {
        // Save and reset transform for capture
        var origTransform = this.canvas.style.transform;
        var origConnTransform = this.connCanvas.style.transform;
        this.canvas.style.transform = 'none';
        this.connCanvas.style.transform = 'none';

        if (this.toolbar) this.toolbar.style.display = 'none';
        if (this.overlay) this.overlay.style.display = 'none';

        html2canvas(this.canvas, {
            backgroundColor: null,
            scale: dpr,
            useCORS: true,
            logging: false,
            width: exportW,
            height: exportH,
        }).then(function (cardCanvas) {
            // Composite cards on top of connectors
            offCtx.drawImage(cardCanvas, 0, 0, exportW, exportH);

            // Restore
            nav.canvas.style.transform = origTransform;
            nav.connCanvas.style.transform = origConnTransform;
            if (nav.toolbar) nav.toolbar.style.display = '';
            if (nav.overlay) nav.overlay.style.display = '';
            nav.showLoader(false);

            // Download
            var link = document.createElement('a');
            link.download = 'family-tree.png';
            link.href = offscreen.toDataURL('image/png');
            link.click();
        }).catch(function () {
            nav.canvas.style.transform = origTransform;
            nav.connCanvas.style.transform = origConnTransform;
            if (nav.toolbar) nav.toolbar.style.display = '';
            if (nav.overlay) nav.overlay.style.display = '';
            nav.showLoader(false);
        });
    } else {
        nav.showLoader(false);
    }
};
