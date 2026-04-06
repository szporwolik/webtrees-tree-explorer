<?php

/**
 * SP Tree Explorer for webtrees
 * A family tree explorer with a modern, card-based UI
 * Copyright (C) 2025-2026 Szymon Porwolik
 * See LICENSE.md file for further details.
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav;

use Fisharebest\Webtrees\Webtrees;
use Fisharebest\Webtrees\Registry;

// webtrees 2.x only — reject webtrees 1.x which defines WT_VERSION
if (defined('WT_VERSION')) {
    return;
}

require_once __DIR__ . '/autoload.php';

return Registry::container()->get(SpTreeExplorer::class);
