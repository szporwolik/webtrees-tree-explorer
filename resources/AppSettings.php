<?php

/**
 * SP Tree Explorer for webtrees
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav;

use Fisharebest\Webtrees\I18N;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Class AppSettings — holds configuration constants and query parameter parsing.
 */
class AppSettings
{
    public const INITIAL_DEPTH = 1;
    public const MIN_DEPTH     = 1;
    public const MAX_DEPTH     = 25;

    private ServerRequestInterface $request;

    public function __construct(ServerRequestInterface $request)
    {
        $this->request = $request;
    }

    public function getDepth(): int
    {
        $depth = (int) ($this->request->getQueryParams()['depth'] ?? self::INITIAL_DEPTH);
        $depth = min($depth, self::MAX_DEPTH);
        return max($depth, self::MIN_DEPTH);
    }
}
