<?php

use Composer\Autoload\ClassLoader;

$loader = new ClassLoader();
$loader->addPsr4('SpTreeExplorer\\FamilyNav\\', __DIR__);
$loader->addPsr4('SpTreeExplorer\\FamilyNav\\', __DIR__ . '/resources');
$loader->addPsr4('SpTreeExplorer\\FamilyNav\\Exceptions\\', __DIR__ . '/Exceptions');
$loader->addPsr4('SpTreeExplorer\\FamilyNav\\Traits\\', __DIR__ . '/Traits');
$loader->addPsr4('SpTreeExplorer\\FamilyNav\\Module\\', __DIR__ . '/Module/TreeNavigator');

$loader->register();
