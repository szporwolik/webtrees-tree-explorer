# SP Tree Explorer

[![release](https://img.shields.io/badge/release-v0.0.1-blue)](https://github.com/szporwolik/webtrees-tree-explorer/releases) [![webtrees](https://img.shields.io/badge/webtrees-2.x-green)](https://webtrees.net) [![license](https://img.shields.io/badge/license-GPL--3.0-orange)](https://github.com/szporwolik/webtrees-tree-explorer/blob/main/LICENSE.md)

An interactive family tree navigator for [webtrees](https://webtrees.net/) — the leading open-source genealogy application.

Built to deliver a clean, modern card-based UI that feels cohesive and powerful for exploring multi-generational family trees. This module was inspired by the [webtrees Interactive Tree](https://webtrees.net/) and the excellent [huhwt-xtv](https://github.com/huhwt/huhwt-xtv) plugin by Hermann Hartenthaler. The goal was to create a convenient and familiar genealogy visualization for people used to popular web genealogy platforms, combining modern UI design with powerful navigation features.

Repo: https://github.com/szporwolik/webtrees-tree-explorer

## Author

Szymon Porwolik — [szymon.porwolik.com](https://szymon.porwolik.com/)

## Features

• Appears in the **Diagrams** menu as "Tree Navigator"  
• Drag-and-pan canvas for exploring large trees  
• Expand / collapse branches with click  
• Center on root person  
• Fullscreen toggle  
• Configurable generation depth (1–25)  
• Gender-coded card borders (blue = male, pink = female)  
• **Search dropdown** to find and navigate to any person in the tree  
• **Multiple marriages support** — all spouses and children from all marriages displayed  
• **Unknown parent placeholders** — when siblings exist but parents don't, synthetic "?" boxes are created  
• Export diagram as PNG image  
• Print-friendly styling  
• AJAX-powered lazy loading of tree branches  
• Share link support for direct navigation

## Screenshots

![SP Tree Explorer - Main View](screenshots/screen_main.png)

## Installation

1. Download or clone this repository  
2. Copy the folder into your webtrees `modules_v4/` directory  
3. Rename it as you prefer (e.g. `sp_tree_explorer`)  
4. Go to **Control Panel → Modules → Charts** and enable the module  
5. Access via **Diagrams → Tree Navigator** from any individual page

## Requirements

• webtrees 2.x  
• PHP 7.4+  
• Modern web browser with JavaScript enabled

## Project Structure

```
├── module.php                      # Entry point (returns module instance)
├── SpTreeExplorer.php              # Main module class
├── SpTreeExplorerHandler.php       # AJAX request handler
├── autoload.php                    # PSR-4 autoloader
├── LICENSE.md                      # GPL-3.0
├── README.md
├── latest-version.txt
├── screenshots/                    # README images
├── Exceptions/
│   └── NavigatorActionMissing.php
├── Module/
│   └── TreeNavigator/
│       └── FamilyTreeRenderer.php  # JSON tree data generator
├── Traits/
│   └── DiagramChartFeature.php     # Chart menu integration
└── resources/
    ├── AppSettings.php
    ├── css/
    │   └── navigator.css           # Complete module stylesheet
    ├── js/
    │   ├── navigator.js            # Main navigation engine
    │   └── html2canvas.1.4.js      # PNG export (MIT)
    └── views/
        ├── inject-script.phtml
        ├── inject-style.phtml
        └── modules/
            └── spNavigator/
                ├── diagram.phtml
                ├── subtitle.phtml
                └── viewport.phtml
```

## Dependencies

**Core:**  
• webtrees 2.x — Genealogy application framework (GPL v3)  
• Uses webtrees API: `Individual`, `Family`, `Tree`, `Auth`, `Registry`, `I18N`, etc.

**Third-party:**  
• [html2canvas 1.4.1](https://html2canvas.hertzen.com/) (MIT License) — PNG export functionality

**JavaScript:**  
• Native ES6+ JavaScript (no external frameworks required)  
• Uses standard browser APIs: Canvas, Fetch, DOM manipulation

## Contributing

This is a personal project. Issues are welcome, but pull requests are not accepted.

## License

[GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html) — same license family as webtrees itself.

Copyright (C) 2025-2026 Szymon Porwolik
