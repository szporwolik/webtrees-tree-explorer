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
use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\FlashMessages;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Menu;
use Fisharebest\Webtrees\Module\AbstractModule;
use Fisharebest\Webtrees\Module\ModuleConfigInterface;
use Fisharebest\Webtrees\Module\ModuleConfigTrait;
use Fisharebest\Webtrees\Module\ModuleGlobalInterface;
use Fisharebest\Webtrees\Module\ModuleGlobalTrait;
use Fisharebest\Webtrees\Module\ModuleChartInterface;
use Fisharebest\Webtrees\Module\ModuleCustomInterface;
use Fisharebest\Webtrees\Module\ModuleCustomTrait;
use Fisharebest\Webtrees\Module\ModuleMenuInterface;
use Fisharebest\Webtrees\Module\ModuleMenuTrait;
use Fisharebest\Webtrees\Module\ModuleTabInterface;
use Fisharebest\Webtrees\Module\ModuleTabTrait;
use Fisharebest\Webtrees\Tree;
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
    ModuleChartInterface, ModuleConfigInterface, ModuleMenuInterface, ModuleTabInterface
{
    use ModuleCustomTrait;
    use ModuleGlobalTrait;
    use ModuleConfigTrait;
    use ModuleMenuTrait;
    use ModuleTabTrait;
    use DiagramChartFeature;

    public function customModuleAuthorName(): string
    {
        return 'Szymon Porwolik';
    }

    public function customModuleVersion(): string
    {
        return '0.7.0';
    }

    public function customModuleLatestVersionUrl(): string
    {
        return 'https://raw.githubusercontent.com/szporwolik/webtrees-tree-explorer/main/latest-version.txt';
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
        $directory  = $this->resourcesFolder() . 'lang' . DIRECTORY_SEPARATOR;
        $normalized = str_replace('_', '-', $language);
        $base       = explode('-', $normalized)[0];

        foreach (array_unique([$language, $normalized, $base]) as $locale) {
            $file = $directory . $locale . '.php';

            if (file_exists($file)) {
                return require $file;
            }
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

    public function defaultTabOrder(): int
    {
        return 70;
    }

    public function canLoadAjax(): bool
    {
        return false;
    }

    public function hasTabContent(Individual $individual): bool
    {
        return $individual->canShow();
    }

    public function isGrayedOut(Individual $individual): bool
    {
        return !$individual->canShow();
    }

    public function getTabContent(Individual $individual): string
    {
        $prefix = 'spT01';
        $renderer = new FamilyTreeRenderer(
            $prefix,
            $this->name(),
            $individual->tree(),
            $individual->xref(),
            $this->customModuleVersion()
        );
        $renderer->setDefaults(
            $this->getPreference('profile_default_details', '1') === '1',
            $this->getPreference('profile_default_advanced', '1') === '1',
            $this->getPreference('profile_default_sources', '1') === '1'
        );
        // Profile tab: load a compact overview around the current person.
        $renderer->setGenerationLimits(2, -2); // grandparents up, grandchildren down
        $renderer->setProfileTabOptions(true, $this->chartUrl($individual));
        $renderer->prepare();

        [$cardHtml, $initScript] = $renderer->buildViewport($individual, true);

        return view($this->name() . '::modules/spNavigator/diagram', [
            'individual'   => $individual,
            'cardHtml'     => $cardHtml,
            'initScript'   => $initScript,
            'module'       => $this->name(),
            'pageHeading'  => $this->pageHeading(),
            'showForm'     => false,
            'tree'         => $individual->tree(),
            'inlineScript' => true,
        ]);
    }

    public function chartBoxMenu(Individual $individual): ?Menu
    {
        return $this->chartMenu($individual);
    }

    /**
     * Top navigation menu entry.
     */
    public function getMenu(Tree $tree): ?Menu
    {
        $individual = $tree->significantIndividual(Auth::user());
        $xref = $individual->canShow() ? $individual->xref() : '';

        return new Menu(
            $this->title(),
            route('module', [
                'module' => $this->name(),
                'action' => 'Chart',
                'tree'   => $tree->name(),
                'xref'   => $xref,
            ]),
            'menu-sptree',
            ['rel' => 'nofollow']
        );
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
                    'module'                  => $moduleName,
                    'moduleVersion'           => $this->customModuleVersion(),
                    'prefix'                  => $prefix,
                    'rootXref'                => '',
                    'tree'                    => $tree,
                    'expandUrl'               => $expandUrl,
                    'searchUrl'               => $searchUrl,
                    'defaultDetails'          => $this->getPreference('default_details', '1') === '1',
                    'defaultAdvancedControls' => $this->getPreference('default_advanced', '1') === '1',
                    'defaultSources'          => $this->getPreference('default_sources', '0') === '1',
                    'profileView'             => false,
                    'fullPageUrl'             => '',
                ]);

                $emptyTreeData = json_encode(['nodes' => [], 'edges' => [], 'rootId' => null], JSON_HEX_TAG | JSON_HEX_AMP);
                $initScript = 'wtpInitCSSColors(); var spNavController = new FamilyNavigator('
                    . json_encode($prefix) . ', true, '
                    . $emptyTreeData . ', '
                    . json_encode($expandUrl) . ', '
                    . json_encode($searchUrl) . ');';

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

        $moduleName = Validator::attributes($request)->string('module');

        $prefix = 'spN01';
        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $individual->xref(), $this->customModuleVersion());
        $renderer->setDefaults(
            $this->getPreference('default_details', '1') === '1',
            $this->getPreference('default_advanced', '1') === '1',
            $this->getPreference('default_sources', '0') === '1'
        );
        $renderer->prepare();

        [$cardHtml, $initScript] = $renderer->buildViewport($individual, true);

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

    /**
     * Admin settings page (GET).
     */
    public function getAdminAction(): ResponseInterface
    {
        $this->layout = 'layouts/administration';

        return $this->viewResponse($this->name() . '::modules/spNavigator/settings', [
            'title'                  => $this->title(),
            'defaultDetails'         => $this->getPreference('default_details', '1'),
            'defaultAdvanced'        => $this->getPreference('default_advanced', '1'),
            'defaultSources'         => $this->getPreference('default_sources', '0'),
            'profileDefaultDetails'  => $this->getPreference('profile_default_details', '1'),
            'profileDefaultAdvanced' => $this->getPreference('profile_default_advanced', '1'),
            'profileDefaultSources'  => $this->getPreference('profile_default_sources', '1'),
        ]);
    }

    /**
     * Admin settings page (POST).
     */
    public function postAdminAction(ServerRequestInterface $request): ResponseInterface
    {
        $this->setPreference('default_details', Validator::parsedBody($request)->string('default_details', '') === '1' ? '1' : '0');
        $this->setPreference('default_advanced', Validator::parsedBody($request)->string('default_advanced', '') === '1' ? '1' : '0');
        $this->setPreference('default_sources', Validator::parsedBody($request)->string('default_sources', '') === '1' ? '1' : '0');
        $this->setPreference('profile_default_details', Validator::parsedBody($request)->string('profile_default_details', '') === '1' ? '1' : '0');
        $this->setPreference('profile_default_advanced', Validator::parsedBody($request)->string('profile_default_advanced', '') === '1' ? '1' : '0');
        $this->setPreference('profile_default_sources', Validator::parsedBody($request)->string('profile_default_sources', '') === '1' ? '1' : '0');

        $message = I18N::translate('The preferences for the module "%s" have been updated.', $this->title());
        FlashMessages::addMessage($message, 'success');

        return redirect($this->getConfigLink());
    }
}
