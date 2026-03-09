<?php

/**
 * SP Tree Explorer for webtrees
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav;

use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\Module\AbstractModule;
use Fisharebest\Webtrees\Registry;
use Fisharebest\Webtrees\Tree;
use Fisharebest\Webtrees\Validator;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

use SpTreeExplorer\FamilyNav\Module\FamilyTreeRenderer;
use SpTreeExplorer\FamilyNav\Exceptions\NavigatorActionMissing;

/**
 * Class SpTreeExplorerHandler — handles AJAX requests for expanding nodes.
 */
class SpTreeExplorerHandler extends AbstractModule implements RequestHandlerInterface
{
    /**
     * Route AJAX requests to the right action.
     */
    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $action = Validator::queryParams($request)->string('action');

        if ($action === 'NodeExpand') {
            return $this->nodeExpandAction($request);
        }

        if ($action === 'NavigateTo') {
            return $this->navigateToAction($request);
        }

        if ($action === 'PersonSearch') {
            return $this->personSearchAction($request);
        }

        throw new NavigatorActionMissing($action);
    }

    /**
     * Expand a single node — return JSON subtree data via AJAX.
     */
    public function nodeExpandAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $rootXref = Validator::queryParams($request)->string('rootXref');
        $targetId = Validator::queryParams($request)->string('fid');
        $personId = Validator::queryParams($request)->string('pid');

        $prefix = Validator::queryParams($request)->string('instance');
        $moduleName = Validator::queryParams($request)->string('module');

        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $rootXref);
        $renderer->restore();

        $json = $renderer->expandNode($targetId, $personId, $tree);

        return response($json, 200, ['Content-Type' => 'application/json']);
    }

    /**
     * Navigate to a new person — return full tree JSON centered on them.
     */
    public function navigateToAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $xref = Validator::queryParams($request)->string('xref');
        $prefix = Validator::queryParams($request)->string('instance');
        $moduleName = Validator::queryParams($request)->string('module');

        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $xref);
        $renderer->prepare();

        $json = $renderer->navigateTo($xref, $tree);

        return response($json, 200, ['Content-Type' => 'application/json']);
    }

    /**
     * Autocomplete search for linking individuals.
     */
    public function personSearchAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $rootXref = Validator::queryParams($request)->string('rootXref');
        $prefix = Validator::queryParams($request)->string('instance');
        $moduleName = Validator::queryParams($request)->string('module');

        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $rootXref);
        $renderer->restore();

        $query = Validator::queryParams($request)->string('q', '');
        $json = $renderer->searchPersons($tree, $prefix, $query);

        return response($json, 200, ['Content-Type' => 'application/json']);
    }
}
