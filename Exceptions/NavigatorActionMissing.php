<?php

/**
 * SP Tree Explorer for webtrees
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav\Exceptions;

use Exception;
use Fisharebest\Webtrees\I18N;

class NavigatorActionMissing extends Exception
{
    public function __construct(string $action = null)
    {
        $message = I18N::translate('Unknown action:') . ' <pre>' . e($action) . '</pre>';
        parent::__construct($message);
    }
}
