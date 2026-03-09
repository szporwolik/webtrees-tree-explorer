<?php

/**
 * SP Tree Explorer for webtrees
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav\Traits;

use Fisharebest\Webtrees\Age;
use Fisharebest\Webtrees\Date;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Menu;

/**
 * Trait DiagramChartFeature — chart menu registration and title/subtitle rendering.
 */
trait DiagramChartFeature
{
    use \Fisharebest\Webtrees\Module\ModuleChartTrait;

    public function chartMenuClass(): string
    {
        return 'menu-chart-tree';
    }

    public function chartBoxMenu(Individual $individual): ?Menu
    {
        return null;
    }

    public function chartTitle(Individual $individual): string
    {
        return I18N::translate('Tree Navigator');
    }

    public function pageHeading(): string
    {
        return I18N::translate('Tree Navigator');
    }

    /**
     * Build a subtitle block showing the person's name, lifespan, and age.
     */
    public function buildSubtitle(Individual $individual): string
    {
        if ($individual->isDead()) {
            $age = (string) new Age($individual->getBirthDate(), $individual->getDeathDate());
        } else {
            $today = new Date(strtoupper(date('d M Y')));
            $age   = (string) new Age($individual->getBirthDate(), $today);
        }

        return view('modules/spNavigator/subtitle', [
            'individual' => $individual,
            'age'        => $age,
        ]);
    }

    public function chartUrl(Individual $individual, array $parameters = []): string
    {
        return route('module', [
            'module' => $this->name(),
            'action' => 'Chart',
            'xref'   => $individual->xref(),
            'tree'   => $individual->tree()->name(),
        ] + $parameters);
    }
}
