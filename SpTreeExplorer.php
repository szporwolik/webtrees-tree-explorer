<?php

/**
 * SP Tree Explorer for webtrees
 * A family tree navigator with a modern, card-based UI
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav;

use Aura\Router\RouterContainer;
use Aura\Router\Map;
use Fig\Http\Message\RequestMethodInterface;
use fisharebest\Localization\Translation;
use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\Http\ViewResponseTrait;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Module\InteractiveTreeModule;
use Fisharebest\Webtrees\Module\ModuleConfigTrait;
use Fisharebest\Webtrees\Module\ModuleGlobalInterface;
use Fisharebest\Webtrees\Module\ModuleChartInterface;
use Fisharebest\Webtrees\Module\ModuleConfigInterface;
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
use SpTreeExplorer\FamilyNav\AppSettings;

/**
 * Class SpTreeExplorer
 *
 * @author  Szymon Porwolik <https://szymon.porwolik.com>
 * @license https://opensource.org/licenses/GPL-3.0 GNU General Public License v3.0
 */
class SpTreeExplorer extends InteractiveTreeModule implements ModuleGlobalInterface, ModuleCustomInterface,
    ModuleChartInterface, ModuleConfigInterface
{
    use ModuleCustomTrait;
    use ModuleConfigTrait;
    use DiagramChartFeature;

    /** @var string Module brand label */
    private string $brandLabel;

    /** @var AppSettings */
    private $appSettings;

    public function __construct()
    {
        $this->brandLabel = '';
    }

    public function customModuleAuthorName(): string
    {
        return 'Szymon Porwolik';
    }

    public function customModuleVersion(): string
    {
        return '0.0.1';
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
        $lang = substr($language, 0, 2);
        $file = $this->resourcesFolder() . 'lang' . DIRECTORY_SEPARATOR . $lang . '.po';
        if (file_exists($file)) {
            return (new Translation($file))->asArray();
        }
        return [];
    }

    public function title(): string
    {
        return I18N::translate('Tree Navigator');
    }

    public function title_long(): string
    {
        return I18N::translate('Tree Navigator');
    }

    public function description(): string
    {
        return I18N::translate('An interactive family tree navigator showing ancestors and descendants.');
    }

    /**
     * Inject CSS and JS into every page head.
     */
    public function headContent(): string
    {
        $cssNav = view("{$this->name()}::inject-style", [
            'path' => $this->assetUrl('css/navigator.css'),
        ]);
        $jsH2c = view("{$this->name()}::inject-script", [
            'path' => $this->assetUrl('js/html2canvas.1.4.js'),
        ]);
        $jsNav = view("{$this->name()}::inject-script", [
            'path' => $this->assetUrl('js/navigator.js'),
        ]);
        return $cssNav . ' ' . $jsH2c . ' ' . $jsNav;
    }

    public function bodyContent(): string
    {
        return '';
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
                ->allows(RequestMethodInterface::METHOD_POST);
        });

        View::registerNamespace($this->name(), $this->resourcesFolder() . 'views/');

        View::registerCustomView('::modules/spNavigator/viewport', $this->name() . '::modules/spNavigator/viewport');
        View::registerCustomView('::modules/spNavigator/diagram', $this->name() . '::modules/spNavigator/diagram');
        View::registerCustomView('::modules/spNavigator/subtitle', $this->name() . '::modules/spNavigator/subtitle');
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

        $this->appSettings = new AppSettings($request);

        $individual = null;
        if ($xref !== '') {
            $individual = Registry::individualFactory()->make($xref, $tree);
            if ($individual !== null) {
                $individual = Auth::checkIndividualAccess($individual, false, true);
            }
        }

        if ($individual === null) {
            return $this->viewResponse('modules/spNavigator/diagram', [
                'individual'  => null,
                'cardHtml'    => '',
                'initScript'  => '',
                'module'      => $this->name(),
                'title'       => I18N::translate('Tree Navigator'),
                'pageHeading' => $this->pageHeading(),
                'showForm'    => true,
                'tree'        => $tree,
            ]);
        }

        $depth = 50;

        $moduleName = Validator::attributes($request)->string('module');

        $prefix = 'spN01';
        $renderer = new FamilyTreeRenderer($prefix, $moduleName, $tree, $individual->xref());
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
