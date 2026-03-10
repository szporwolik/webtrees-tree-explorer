<?php

/**
 * SP Tree Explorer for webtrees
 * A family tree explorer with a modern, card-based UI
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav;

use Aura\Router\RouterContainer;
use Aura\Router\Map;
use Fig\Http\Message\RequestMethodInterface;
use Fisharebest\Localization\Translation;
use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Menu;
use Fisharebest\Webtrees\Module\AbstractModule;
use Fisharebest\Webtrees\Module\ModuleGlobalInterface;
use Fisharebest\Webtrees\Module\ModuleGlobalTrait;
use Fisharebest\Webtrees\Module\ModuleChartInterface;
use Fisharebest\Webtrees\Module\ModuleCustomInterface;
use Fisharebest\Webtrees\Module\ModuleCustomTrait;
use Fisharebest\Webtrees\Registry;
use Fisharebest\Webtrees\Validator;
use Fisharebest\Webtrees\View;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

use SpTreeExplorer\FamilyNav\SpTreeExplorerHandler;
use SpTreeExplorer\FamilyNav\Module\FamilyTreeRenderer;
use SpTreeExplorer\FamilyNav\Traits\DiagramChartFeature;

/**
 * Class SpTreeExplorer
 *
 * @author  Szymon Porwolik <https://szymon.porwolik.com>
 * @license https://opensource.org/licenses/GPL-3.0 GNU General Public License v3.0
 */
class SpTreeExplorer extends AbstractModule implements ModuleGlobalInterface, ModuleCustomInterface,
    ModuleChartInterface
{
    use ModuleCustomTrait;
    use ModuleGlobalTrait;
    use DiagramChartFeature;

    public function customModuleAuthorName(): string
    {
        return 'Szymon Porwolik';
    }

    public function customModuleVersion(): string
    {
        return '0.2.0';
    }

    public function customModuleLatestVersionUrl(): string
    {
        return 'https://github.com/szporwolik/webtrees-tree-explorer/releases/latest';
    }

    public function customModuleSupportUrl(): string
    {
        return 'https://github.com/szporwolik/webtrees-tree-explorer';
    }

    public function resourcesFolder(): string
    {
        return __DIR__ . DIRECTORY_SEPARATOR . 'resources' . DIRECTORY_SEPARATOR;
    }

    public function customTranslations(string $language): array
    {
        $file = $this->resourcesFolder() . 'lang' . DIRECTORY_SEPARATOR . $language . '.mo';
        if (file_exists($file)) {
            return (new Translation($file))->asArray();
        }
        return [];
    }

    public function title(): string
    {
        return I18N::translate('Tree Explorer');
    }

    public function description(): string
    {
        return I18N::translate('An interactive tree explorer showing ancestors and descendants.');
    }

    /**
     * Diagrams chart menu entry.
     */
    public function chartMenu(Individual $individual): Menu
    {
        return new Menu(
            $this->chartTitle($individual),
            $this->chartUrl($individual),
            $this->chartMenuClass(),
            ['rel' => 'nofollow']
        );
    }

    /**
     * Inject CSS and JS into every page head.
     */
    public function headContent(): string
    {
        $cssNav = view("{$this->name()}::inject-style", [
            'path' => $this->assetUrl('css/navigator.css'),
        ]);
        $jsNav = view("{$this->name()}::inject-script", [
            'path' => $this->assetUrl('js/navigator.js'),
        ]);
        return $cssNav . ' ' . $jsNav;
    }

    /**
     * Register routes and view namespace on boot.
     */
    public function boot(): void
    {
        $routerContainer = Registry::container()->get(RouterContainer::class);
        assert($routerContainer instanceof RouterContainer);

        $map = $routerContainer->getMap();

        $map->attach('', '/tree/{tree}', static function (Map $router) {
            $router->get(SpTreeExplorerHandler::class, '/sp-tree-nav')
                ->allows(RequestMethodInterface::METHOD_GET, RequestMethodInterface::METHOD_POST);
        });

        View::registerNamespace($this->name(), $this->resourcesFolder() . 'views/');

        View::registerCustomView('::modules/spNavigator/viewport', $this->name() . '::modules/spNavigator/viewport');
        View::registerCustomView('::modules/spNavigator/diagram', $this->name() . '::modules/spNavigator/diagram');
    }

    /**
     * Handle GET request for chart display.
     */
    public function getChartAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $user = Validator::attributes($request)->user();
        $xref = Validator::queryParams($request)->isXref()->string('xref', '');

        Auth::checkComponentAccess($this, ModuleChartInterface::class, $tree, $user);

        $individual = null;
        if ($xref !== '') {
            $individual = Registry::individualFactory()->make($xref, $tree);
            if ($individual !== null) {
                $individual = Auth::checkIndividualAccess($individual, false, true);
            }
        }

        if ($individual === null) {
                // Build empty viewport with search functionality
                $prefix = 'spN01';
                $moduleName = Validator::attributes($request)->string('module');
            
                $expandUrl = route(SpTreeExplorerHandler::class, [
                    'module'   => $moduleName,
                    'action'   => 'NodeExpand',
                    'tree'     => $tree->name(),
                    'rootXref' => '',
                ]);

                $searchUrl = route(SpTreeExplorerHandler::class, [
                    'module'   => $moduleName,
                    'action'   => 'PersonSearch',
                    'tree'     => $tree->name(),
                    'rootXref' => '',
                ]);

                $cardHtml = view('modules/spNavigator/viewport', [
                    'module'        => $moduleName,
                    'moduleVersion' => $this->customModuleVersion(),
                    'prefix'        => $prefix,
                    'rootXref'      => '',
                    'tree'          => $tree,
                    'expandUrl'     => $expandUrl,
                    'searchUrl'     => $searchUrl,
                ]);

                $jsExpandUrl = addcslashes($expandUrl, "'\\");
                $jsSearchUrl = addcslashes($searchUrl, "'\\");
                $emptyTreeData = json_encode(['nodes' => [], 'edges' => [], 'rootId' => null]);
                $initScript = 'wtpInitCSSColors(); var ' . $prefix . 'Controller = new FamilyNavigator("'
                    . $prefix . '", true, '
                    . $emptyTreeData . ', "'
                    . $jsExpandUrl . '", "'
                    . $jsSearchUrl . '");';

                return $this->viewResponse('modules/spNavigator/diagram', [
                    'individual'  => null,
                    'cardHtml'    => $cardHtml,
                    'initScript'  => $initScript,
                    'module'      => $this->name(),
                    'title'       => I18N::translate('Tree Explorer'),
                    'pageHeading' => $this->pageHeading(),
                    'showForm'    => true,
                    'tree'        => $tree,
                ]);
        }

        $depth = 50;

        $moduleName = Validator::attributes($request)->string('module');

        $prefix = 'spN01';
        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $individual->xref(), $this->customModuleVersion());
        $renderer->prepare();

        [$cardHtml, $initScript] = $renderer->buildViewport($individual, $depth, true);

        return $this->viewResponse('modules/spNavigator/diagram', [
            'individual'  => $individual,
            'cardHtml'    => $cardHtml,
            'initScript'  => $initScript,
            'module'      => $this->name(),
            'title'       => $this->chartTitle($individual),
            'pageHeading' => $this->pageHeading(),
            'showForm'    => false,
            'tree'        => $tree,
        ]);
    }

    /**
     * Handle POST (form submit) for chart display.
     */
    public function postChartAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $xref = Validator::parsedBody($request)->string('xref', '');

        return redirect(route('module', [
            'module' => $this->name(),
            'action' => 'Chart',
            'tree'   => $tree->name(),
            'xref'   => $xref,
        ]));
    }
}
