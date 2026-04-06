<?php

/**
 * SP Tree Explorer for webtrees
 * Family tree rendering engine â€” JSON data provider
 * Copyright (C) 2025-2026 Szymon Porwolik
 */

declare(strict_types=1);

namespace SpTreeExplorer\FamilyNav\Module;

use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\Age;
use Fisharebest\Webtrees\DB;
use Fisharebest\Webtrees\Registry;
use Fisharebest\Webtrees\Family;
use Fisharebest\Webtrees\Gedcom;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Http\RequestHandlers\AddNewFact;
use Fisharebest\Webtrees\Session;
use Fisharebest\Webtrees\Tree;
use Illuminate\Support\Collection;

use SpTreeExplorer\FamilyNav\SpTreeExplorerHandler;

/**
 * Class FamilyTreeRenderer â€” generates JSON tree data for the JS layout engine.
 *
 * Output format: an array of "node" objects, each describing one person
 * and their edges (parent/child/spouse). The JS client is responsible for
 * layout, card rendering, and connector drawing.
 */
class FamilyTreeRenderer
{
    private string $prefix;
    private string $moduleName;
    private string $moduleVersion;
    private Tree $tree;
    private string $rootXref;
    private string $jsHandle = 'spNav';

    /** @var array<string, bool> Tracks visited xrefs to avoid cycles */
    private array $visited = [];

    /** @var array<string, bool> Xrefs already rendered on the client (skip during expansion) */
    private array $knownXrefs = [];

    /** @var int Maximum ancestor generation (0 = origin, positive = up) */
    private int $maxGenUp = 4;

    /** @var int Minimum descendant generation (0 = origin, negative = down) */
    private int $maxGenDown = -3;

    /** @var array<string, array> Collected nodes keyed by unique id */
    private array $nodes = [];

    /** @var array<array> Collected edges */
    private array $edges = [];

    /** @var int Unique node id counter */
    private int $nodeIdCounter = 0;

    /** @var bool Default state for the Details toggle */
    private bool $defaultDetails = true;

    /** @var bool Default state for the Advanced Controls toggle */
    private bool $defaultAdvancedControls = true;

    /** @var bool Default state for the Sources toggle */
    private bool $defaultSources = false;

    public function __construct(string $prefix, string $moduleName, Tree $tree, string $rootXref, string $moduleVersion = '')
    {
        $this->prefix     = $prefix;
        $this->moduleName = $moduleName;
        $this->moduleVersion = $moduleVersion;
        $this->tree       = $tree;
        $this->rootXref   = $rootXref;
    }

    public function setDefaults(bool $details, bool $advancedControls, bool $sources = false): void
    {
        $this->defaultDetails = $details;
        $this->defaultAdvancedControls = $advancedControls;
        $this->defaultSources = $sources;
    }

    /**
     * Initialize session tracking for visited nodes.
     */
    public function prepare(): void
    {
        $tName = $this->tree->name();
        $visited = [];
        $visited[$tName] = [];
        $visited[$tName][$this->rootXref] = [];
        Session::put('SPNav_visited', $visited);
    }

    /**
     * Restore session state for AJAX continuation.
     */
    public function restore(): void
    {
        $visited = Session::get('SPNav_visited', []);
        $tName = $this->tree->name();
        $this->nodeIdCounter = (int) ($visited[$tName][$this->rootXref]['_nodeIdCounter_'] ?? 0);
    }

    private function markVisited(string $xref): int
    {
        $visited = Session::get('SPNav_visited', []);
        $tName = $this->tree->name();
        $root = $this->rootXref;

        $count = $visited[$tName][$root][$xref] ?? -1;
        $visited[$tName][$root][$xref] = $count + 1;
        $visited[$tName][$root]['_nodeIdCounter_'] = $this->nodeIdCounter;
        Session::put('SPNav_visited', $visited);

        return $count + 1;
    }

    private function nextNodeId(): string
    {
        return 'n' . ($this->nodeIdCounter++);
    }

    private function saveNodeIdCounter(): void
    {
        $visited = Session::get('SPNav_visited', []);
        $tName = $this->tree->name();
        $visited[$tName][$this->rootXref]['_nodeIdCounter_'] = $this->nodeIdCounter;
        Session::put('SPNav_visited', $visited);
    }

    /**
     * Pre-seed the visited array with xrefs already known to the client.
     * This prevents the server from re-building subtrees for people
     * that are already rendered in the browser.
     */
    public function setKnownXrefs(array $xrefs): void
    {
        foreach ($xrefs as $xref) {
            $this->knownXrefs[$xref] = true;
        }
    }

    /**
     * Build the full viewport: outer chrome + JSON data for JS.
     *
     * @return string[] [html, js_init_code]
     */
    public function buildViewport(Individual $person, bool $expanded): array
    {
        $cardName = $this->prefix . 'D';
        $this->prefix = $cardName;

        // Build JSON tree data
        $this->nodes = [];
        $this->edges = [];
        $this->visited = [];
        $this->collectTree($person, 0, null, true, '');

        // Save nodeIdCounter to session so AJAX expansions continue from here
        $this->saveNodeIdCounter();

        $treeData = json_encode([
            'nodes' => array_values($this->nodes),
            'edges' => $this->edges,
            'rootId' => 'n0',
        ], JSON_UNESCAPED_UNICODE);

        $expandUrl = route(SpTreeExplorerHandler::class, [
            'module'   => $this->moduleName,
            'action'   => 'NodeExpand',
            'tree'     => $this->tree->name(),
            'rootXref' => $this->rootXref,
        ]);

        $searchUrl = route(SpTreeExplorerHandler::class, [
            'module'   => $this->moduleName,
            'action'   => 'PersonSearch',
            'tree'     => $this->tree->name(),
            'rootXref' => $this->rootXref,
        ]);

        $html = view('modules/spNavigator/viewport', [
            'module'                  => $this->moduleName,
            'moduleVersion'           => $this->moduleVersion,
            'prefix'                  => $cardName,
            'rootXref'                => $this->rootXref,
            'tree'                    => $this->tree,
            'expandUrl'               => $expandUrl,
            'searchUrl'               => $searchUrl,
            'defaultDetails'          => $this->defaultDetails,
            'defaultAdvancedControls' => $this->defaultAdvancedControls,
            'defaultSources'          => $this->defaultSources,
        ]);

        $isExpanded = $expanded ? 'true' : 'false';
        $jsExpandUrl = addcslashes($expandUrl, "'\\");
        $jsSearchUrl = addcslashes($searchUrl, "'\\");
        $jsInit = 'wtpInitCSSColors(); var ' . $this->jsHandle . 'Controller = new FamilyNavigator("'
            . $cardName . '", ' . $isExpanded . ', '
            . $treeData . ', "'
            . $jsExpandUrl . '", "'
            . $jsSearchUrl . '");';

        return [$html, $jsInit];
    }

    /**
     * Build a person's JSON data.
     */
    private function buildPersonData(Individual $person, bool $isOrigin = false): array
    {
        $accessLevel = Auth::accessLevel($this->tree);
        $canShow = $person->canShow($accessLevel);

        // Private person â€” return minimal structure with only safe data
        if (!$canShow) {
            return [
                'xref'     => $person->xref(),
                'name'     => strip_tags($person->fullName()), // returns "Private" automatically
                'years'    => '',
                'dateLine' => '',
                'dateLineQuality' => 'unknown',
                'birthPlace' => '',
                'deathPlace' => '',
                'fatherAgeAtBirth' => null,
                'motherAgeAtBirth' => null,
                'sex'      => $person->sex(),
                'url'      => '',
                'addNoteUrl' => '',
                'sourceCount' => 0,
                'noteCount' => 0,
                'mediaCount' => 0,
                'thumb'    => null,
                'isDead'   => false,
                'isOrigin' => $isOrigin,
                'isPrivate' => true,
            ];
        }

        $birthDate = $person->getBirthDate();
        $deathDate = $person->getDeathDate();
        $birthMeta = ['quality' => 'exact', 'place' => ''];
        $deathMeta = ['quality' => 'exact', 'place' => ''];

        foreach ($person->facts(Gedcom::BIRTH_EVENTS, true) as $fact) {
            if ($fact->tag() === 'INDI:BIRT') {
                $birthMeta = $this->extractEventMeta($fact->gedcom());
                break;
            }
        }

        foreach ($person->facts(Gedcom::DEATH_EVENTS, true) as $fact) {
            if ($fact->tag() === 'INDI:DEAT') {
                $deathMeta = $this->extractEventMeta($fact->gedcom());
                break;
            }
        }

        $birthText = $birthDate->isOK() ? strip_tags($birthDate->display($this->tree, null, true)) : '';
        $deathText = $deathDate->isOK() ? strip_tags($deathDate->display($this->tree, null, true)) : '';

        // Build a readable lifespan line for the card.
        $dash = "\u{2013}"; // en-dash
        if ($birthText !== '' && $deathText !== '') {
            $dateLine = $birthText . ' ' . $dash . ' ' . $deathText;
        } elseif ($birthText !== '' && $person->isDead()) {
            $dateLine = $birthText . ' ' . $dash . ' ?';
        } elseif ($birthText !== '') {
            $dateLine = $birthText;
        } elseif ($deathText !== '') {
            $dateLine = '? ' . $dash . ' ' . $deathText;
        } else {
            $dateLine = '';
        }

        $fatherAgeAtBirth = null;
        $motherAgeAtBirth = null;

        if ($birthDate->isOK()) {
            $parentFamily = $this->bestParentFamily($person);
            if ($parentFamily instanceof Family) {
                $father = $parentFamily->husband();
                if ($father instanceof Individual && $father->canShow($accessLevel) && $father->getBirthDate()->isOK()) {
                    $fatherAge = new Age($father->getBirthDate(), $birthDate);
                    if ($fatherAge->ageYears() >= 0) {
                        $fatherAgeAtBirth = $fatherAge->ageYears();
                    }
                }

                $mother = $parentFamily->wife();
                if ($mother instanceof Individual && $mother->canShow($accessLevel) && $mother->getBirthDate()->isOK()) {
                    $motherAge = new Age($mother->getBirthDate(), $birthDate);
                    if ($motherAge->ageYears() >= 0) {
                        $motherAgeAtBirth = $motherAge->ageYears();
                    }
                }
            }
        }

        $thumbUrl = '';
        try {
            $imgTag = $person->displayImage(80, 80, 'contain', []);
            if (preg_match('/src=["\']([^"\']+)["\']/', $imgTag, $m)) {
                $thumbUrl = html_entity_decode($m[1], ENT_QUOTES, 'UTF-8');
            }
        } catch (\Throwable $e) {
            // No image available
        }

        $privateGedcom = $person->privatizeGedcom($accessLevel);
        $sourceCount = $this->countAllTags($privateGedcom, 'SOUR');
        $noteCount   = $this->countAllTags($privateGedcom, 'NOTE');
        $mediaCount  = $this->countAllTags($privateGedcom, 'OBJE');

        return [
            'xref'     => $person->xref(),
            'name'     => strip_tags($person->fullName()),
            'years'    => strip_tags($person->lifespan()),
            'dateLine' => $dateLine,
            'dateLineQuality' => $this->mergeDateQuality($birthMeta['quality'], $deathMeta['quality']),
            'birthPlace' => $birthMeta['place'],
            'deathPlace' => $deathMeta['place'],
            'fatherAgeAtBirth' => $fatherAgeAtBirth,
            'motherAgeAtBirth' => $motherAgeAtBirth,
            'sex'      => $person->sex(),
            'url'      => $person->url(),
            'addNoteUrl' => route(AddNewFact::class, [
                'tree' => $this->tree->name(),
                'xref' => $person->xref(),
                'fact' => 'NOTE',
            ]),
            'sourceCount' => $sourceCount,
            'noteCount' => $noteCount,
            'mediaCount' => $mediaCount,
            'thumb'    => $thumbUrl,
            'isDead'   => $person->isDead(),
            'isOrigin' => $isOrigin,
            'isPrivate' => false,
        ];
    }

    /**
     * Build data for an unknown/placeholder person.
     */
    private function buildUnknownPersonData(string $sex): array
    {
        return [
            'xref'        => null,
            'name'        => '?',
            'years'       => '',
            'dateLine'    => '',
            'dateLineQuality' => 'unknown',
            'birthPlace'  => '',
            'deathPlace'  => '',
            'fatherAgeAtBirth' => null,
            'motherAgeAtBirth' => null,
            'sex'         => $sex,
            'url'         => '',
            'addNoteUrl'  => '',
            'sourceCount' => 0,
            'noteCount'   => 0,
            'mediaCount'  => 0,
            'thumb'       => null,
            'isDead'      => false,
            'isOrigin'    => false,
            'isUnknown'   => true,
        ];
    }

    /**
     * Find the best parent family for an individual.
     * Prefers families with real parents, then families with siblings, skips empty ones.
     */
    private function bestParentFamily(Individual $person): ?Family
    {
        $withSiblings = null;
        foreach ($person->childFamilies() as $fam) {
            if (($fam->husband() instanceof Individual) || ($fam->wife() instanceof Individual)) {
                return $fam; // Has real parents â€” best choice
            }
            if ($withSiblings === null) {
                foreach ($fam->children() as $ch) {
                    if ($ch->xref() !== $person->xref()) {
                        $withSiblings = $fam;
                        break;
                    }
                }
            }
        }
        return $withSiblings;
    }

    /**
     * Recursively collect nodes and edges for the tree.
     *
     * direction:  0 = origin (show both up & down)
     *             1 = ancestor direction (only up + siblings of path child)
     *            -1 = descendant direction (only down)
     *
     * @return string The node ID assigned to this person's "couple node"
     */
    private function collectTree(Individual $person, int $direction,
                                 ?Family $throughFamily, bool $isOrigin,
                                 string $pathChildXref, int $generation = 0): string
    {
        $xref = $person->xref();

        // Skip people already rendered on the client (descendant direction only)
        if ($direction <= 0 && isset($this->knownXrefs[$xref])) {
            return '';
        }

        // Capture birth date and original xref before any gender swap
        $childBirthJd = $person->getBirthDate()->julianDay();
        $originalChildXref = $xref;

        // Cycle guard â€” person already visited in this direction (pedigree collapse).
        // Build a display-only node with spouse data so it renders as a couple
        // card with a proper couple-line, but do NOT recurse into ancestors/children.
        $visitKey = $xref . ':' . $direction;
        if (isset($this->visited[$visitKey])) {
            $nodeId = $this->nextNodeId();
            $personData = $this->buildPersonData($person, $isOrigin);

            $guardFamilies = [];
            $guardSwapped = false;
            $guardSpouseFams = $person->spouseFamilies()->toArray();
            usort($guardSpouseFams, [$this, 'compareByMarriageDate']);

            foreach ($guardSpouseFams as $gfi => $gSpFam) {
                $gSpouse = $gSpFam->spouse($person);
                $gSpouseData = null;
                if ($gSpouse instanceof Individual) {
                    // Keep the male on the left for single-family opposite-sex couples.
                    if (count($guardSpouseFams) === 1
                        && $person->sex() === 'F' && $gSpouse->sex() === 'M') {
                        $gSpouseData = $personData;
                        $personData = $this->buildPersonData($gSpouse);
                        $guardSwapped = true;
                        $originalChildXref = $xref;
                    } else {
                        $gSpouseData = $this->buildPersonData($gSpouse);
                    }
                }
                $guardFamilies[] = [
                    'spouse'                 => $gSpouseData,
                    'marriageDate'           => '',
                    'marriagePlace'          => '',
                    'marriageQuality'        => 'unknown',
                    'married'                => false,
                    'divorced'               => false,
                    'divorceDate'            => '',
                    'divorcePlace'           => '',
                    'divorceQuality'         => 'unknown',
                    'durationLabel'          => '',
                    'hasNextRelationship'    => isset($guardSpouseFams[$gfi + 1]),
                    'familySourceCount'      => 0,
                    'familyNoteCount'        => 0,
                    'familyMediaCount'       => 0,
                    'familyUrl'              => $gSpFam->url(),
                    'familyXref'             => $gSpFam->xref(),
                    'spouseHasParents'       => false,
                    'spouseParentFamilyXref' => '',
                    'husbandAgeAtMarriage'   => null,
                    'wifeAgeAtMarriage'      => null,
                ];
            }

            $this->nodes[$nodeId] = [
                'id'        => $nodeId,
                'type'      => 'couple',
                'person'    => $personData,
                'families'  => $guardFamilies,
                'isOrigin'  => false,
                'direction' => $direction,
                'generation' => $generation,
                'hasMultipleAncestorLines' => false,
                'ancestorLines' => [],
                'activeAncestorLine' => 0,
                'personHasParents' => false,
                'genderSwapped' => $guardSwapped,
                'childBirthJd' => $childBirthJd,
                'originalChildXref' => $originalChildXref,
            ];

            // In ancestor direction, collect siblings/half-siblings below the
            // cycle-guard node just like a regular ancestor node would.
            // collectSiblings â†’ collectTree checks $this->visited / knownXrefs
            // so duplicates are safely prevented.
            if ($direction === 1) {
                foreach ($guardSpouseFams as $gfi => $gSpFam) {
                    if ($throughFamily instanceof Family && $gSpFam->xref() === $throughFamily->xref()) {
                        $this->collectSiblings($throughFamily, $pathChildXref, $nodeId, $gfi, $generation);
                    } else {
                        $this->collectSiblings($gSpFam, '', $nodeId, $gfi, $generation);
                    }
                }
            }

            return $nodeId;
        }
        $this->visited[$visitKey] = true;

        $this->markVisited($xref);

        $nodeId = $this->nextNodeId();
        $personData = $this->buildPersonData($person, $isOrigin);

        // --- Build families array ---
        // Collect all (or filtered) spouse families
        $allSpouseFamilies = $person->spouseFamilies()->toArray();
        usort($allSpouseFamilies, [$this, 'compareByMarriageDate']);

        // In ancestor direction, show all families but track which one is the "through" family
        $throughFamilyXref = ($throughFamily instanceof Family) ? $throughFamily->xref() : null;

        $families = [];
        $familyObjects = [];
        $genderSwapped = false;

        foreach ($allSpouseFamilies as $famIdx => $spouseFamily) {
            $spouse = $spouseFamily->spouse($person);
            $spouseData = null;
            $divorced = false;
            $married = false;
            $marriageDate = '';
            $divorceDate = '';
            $marriagePlace = '';
            $divorcePlace = '';
            $marriageQuality = 'unknown';
            $divorceQuality = 'unknown';
            $marriageJd = 0;
            $divorceJd = 0;
            $familyUrl = $spouseFamily->url();
            $spouseHasParents = false;
            $spouseParentFamilyXref = '';
            $nextMarriageJd = 0;
            $hasNextRelationship = isset($allSpouseFamilies[$famIdx + 1]);

            if (isset($allSpouseFamilies[$famIdx + 1]) && $allSpouseFamilies[$famIdx + 1] instanceof Family) {
                $nextMarriageJd = $this->firstMarriageJulianDay($allSpouseFamilies[$famIdx + 1]);
            }

            if ($spouse instanceof Individual) {
                foreach ($spouseFamily->facts(Gedcom::MARRIAGE_EVENTS, true) as $fact) {
                    if ($fact->tag() === 'FAM:MARR') {
                        $married = true;
                    }
                    $meta = $this->extractEventMeta($fact->gedcom());
                    if ($marriagePlace === '' && $meta['place'] !== '') {
                        $marriagePlace = $meta['place'];
                    }
                    if ($marriageQuality === 'unknown') {
                        $marriageQuality = $meta['quality'];
                    }
                    $mDate = $fact->date();
                    if ($mDate->isOK()) {
                        $marriageDate = strip_tags($mDate->display());
                        $marriageJd = $mDate->julianDay();
                    }
                }
                foreach ($spouseFamily->facts(Gedcom::DIVORCE_EVENTS, true) as $fact) {
                    $divorced = true;
                    $meta = $this->extractEventMeta($fact->gedcom());
                    if ($divorcePlace === '' && $meta['place'] !== '') {
                        $divorcePlace = $meta['place'];
                    }
                    if ($divorceQuality === 'unknown') {
                        $divorceQuality = $meta['quality'];
                    }
                    $dDate = $fact->date();
                    if ($dDate->isOK()) {
                        $divorceDate = strip_tags($dDate->display());
                        $divorceJd = $dDate->julianDay();
                    }
                }
                $spouseData = $this->buildPersonData($spouse);
                $spouseData['divorced'] = $divorced;

                // Keep the male on the left for single-family opposite-sex couples.
                // The wrong-partner bug is handled separately via family-aware ancestor matching.
                if (count($allSpouseFamilies) === 1 && $person->sex() === 'F' && $spouse->sex() === 'M') {
                    $tmp = $personData;
                    $personData = $spouseData;
                    $spouseData = $tmp;
                    $tmpIndiv = $person;
                    $person = $spouse;
                    $spouse = $tmpIndiv;
                    $xref = $person->xref();
                    $genderSwapped = true;
                }

                $spParentFam = $this->bestParentFamily($spouse);
                if ($spParentFam instanceof Family) {
                    $spHasReal = ($spParentFam->husband() instanceof Individual)
                              || ($spParentFam->wife() instanceof Individual);
                    if ($spHasReal) {
                        $spouseHasParents = true;
                    } else {
                        // No real parents but check for siblings â†’ unknown parent boxes
                        foreach ($spParentFam->children() as $ch) {
                            if ($ch->xref() !== $spouse->xref()) {
                                $spouseHasParents = true;
                                break;
                            }
                        }
                    }
                    if ($spouseHasParents) {
                        $spouseParentFamilyXref = $spParentFam->xref();
                    }
                }
            }

            $privateFamGedcom = $spouseFamily->privatizeGedcom(Auth::accessLevel($this->tree));
            $familySourceCount = $this->countAllTags($privateFamGedcom, 'SOUR');
            $familyNoteCount   = $this->countAllTags($privateFamGedcom, 'NOTE');
            $familyMediaCount  = $this->countAllTags($privateFamGedcom, 'OBJE');

            // Death date JDs for duration fallback (gate behind canShow to respect privacy)
            $personDeathJd = ($person->canShow() && $person->getDeathDate()->isOK()) ? $person->getDeathDate()->julianDay() : 0;
            $spouseDeathJd = ($spouse instanceof Individual && $spouse->canShow() && $spouse->getDeathDate()->isOK()) ? $spouse->getDeathDate()->julianDay() : 0;
            $durationLabel = $this->formatRelationshipDuration($marriageJd, $divorceJd, $nextMarriageJd, $personDeathJd, $spouseDeathJd);

            // Ages at marriage (using canonical husband/wife from the family record)
            $husbandAgeAtMarriage = null;
            $wifeAgeAtMarriage = null;
            if ($marriageJd > 0) {
                $marriageDateObj = $spouseFamily->getMarriageDate();
                $husb = $spouseFamily->husband();
                if ($husb instanceof Individual && $husb->canShow() && $husb->getBirthDate()->isOK()) {
                    $hAge = new Age($husb->getBirthDate(), $marriageDateObj);
                    if ($hAge->ageYears() >= 0) {
                        $husbandAgeAtMarriage = $hAge->ageYears();
                    }
                }
                $wif = $spouseFamily->wife();
                if ($wif instanceof Individual && $wif->canShow() && $wif->getBirthDate()->isOK()) {
                    $wAge = new Age($wif->getBirthDate(), $marriageDateObj);
                    if ($wAge->ageYears() >= 0) {
                        $wifeAgeAtMarriage = $wAge->ageYears();
                    }
                }
            }

            $families[] = [
                'spouse'       => $spouseData,
                'marriageDate' => $marriageDate,
                'marriagePlace' => $marriagePlace,
                'marriageQuality' => $marriageQuality,
                'married'      => $married,
                'divorced'     => $divorced,
                'divorceDate'  => $divorceDate,
                'divorcePlace' => $divorcePlace,
                'divorceQuality' => $divorceQuality,
                'durationLabel' => $durationLabel,
                'hasNextRelationship' => $hasNextRelationship,
                'familySourceCount' => $familySourceCount,
                'familyNoteCount' => $familyNoteCount,
                'familyMediaCount' => $familyMediaCount,
                'familyUrl'    => $familyUrl,
                'familyXref'   => $spouseFamily->xref(),
                'spouseHasParents' => $spouseHasParents,
                'spouseParentFamilyXref' => $spouseParentFamilyXref,
                'husbandAgeAtMarriage' => $husbandAgeAtMarriage,
                'wifeAgeAtMarriage' => $wifeAgeAtMarriage,
            ];
            $familyObjects[] = $spouseFamily;
        }

        // --- Ancestor lines ---
        $personHasParents = false;
        $ancestorLines = [];
        $parentFamily = $this->bestParentFamily($person);
        if ($parentFamily instanceof Family) {
            // Only mark as having parents if at least one parent individual exists
            // OR if siblings exist (triggers unknown parent boxes)
            $hasRealParent = ($parentFamily->husband() instanceof Individual)
                          || ($parentFamily->wife() instanceof Individual);
            if (!$hasRealParent) {
                // Check for siblings â†’ unknown parent boxes
                foreach ($parentFamily->children() as $ch) {
                    if ($ch->xref() !== $xref) {
                        $hasRealParent = true;
                        break;
                    }
                }
            }
            if ($hasRealParent) {
                $personHasParents = true;
                $ancestorLines[] = [
                    'familyXref' => $parentFamily->xref(),
                    'type' => 'self',
                    'personXref' => $xref,
                    'lineIndex' => 0,
                ];
            }
        }

        // Add one ancestor line per spouse family, matching the sorted family order.
        foreach ($familyObjects as $familyIndex => $spouseFamily) {
            $spouse = $spouseFamily->spouse($person);
            if (!$spouse instanceof Individual) {
                continue;
            }

            $spParentFam = $this->bestParentFamily($spouse);
            if ($spParentFam instanceof Family) {
                $ancestorLines[] = [
                    'familyXref' => $spParentFam->xref(),
                    'type' => 'spouse',
                    'spouseXref' => $spouse->xref(),
                    'familyIndex' => $familyIndex,
                    'lineIndex' => $familyIndex + 1,
                ];
            }
        }

        $hasMultipleAncestorLines = count($ancestorLines) > 1;

        // --- Store node ---
        $this->nodes[$nodeId] = [
            'id'        => $nodeId,
            'type'      => 'couple',
            'person'    => $personData,
            'families'  => $families,
            'isOrigin'  => $isOrigin,
            'direction' => $direction,
            'generation' => $generation,
            'hasMultipleAncestorLines' => $hasMultipleAncestorLines,
            'ancestorLines' => $ancestorLines,
            'activeAncestorLine' => 0,
            'personHasParents' => $personHasParents,
            'genderSwapped' => $genderSwapped,
            'childBirthJd' => $childBirthJd,
            'originalChildXref' => $originalChildXref,
        ];

        // --- Children below (collected BEFORE ancestors so that the main
        //     descendant tree gets first-visit priority; ancestor-sibling
        //     walks that revisit the same people via pedigree collapse will
        //     then correctly hit the cycle guard instead of stealing slots) ---
        if ($direction <= 0) {
            foreach ($familyObjects as $fi => $famObj) {
                $this->collectChildren($person, $nodeId, $famObj, '', $fi, $generation);
            }
        } elseif ($direction === 1) {
            // In ancestor direction: collect siblings from throughFamily,
            // and children from OTHER families (half-siblings from other marriages)
            foreach ($familyObjects as $fi => $famObj) {
                if ($throughFamily instanceof Family && $famObj->xref() === $throughFamily->xref()) {
                    // This is the family we came through â€” collect siblings (excluding the path child)
                    $this->collectSiblings($throughFamily, $pathChildXref, $nodeId, $fi, $generation);
                } else {
                    // Other families â€” collect all children (half-siblings)
                    $this->collectSiblings($famObj, '', $nodeId, $fi, $generation);
                }
            }
        }

        // --- Ancestors above (after descendants, see comment above) ---
        if ($direction >= 0) {
            $this->collectAncestors($person, $nodeId, $throughFamily, $generation);
        }

        return $nodeId;
    }

    /**
     * Collect ancestor nodes for a person.
     */
    private function collectAncestors(Individual $person, string $childNodeId,
                                      ?Family $throughFamily, int $generation = 0): void
    {
        $xref = $person->xref();
        $parentFamily = $this->bestParentFamily($person);

        // Person's own parent family
        if ($parentFamily instanceof Family) {
            $parentPerson = $parentFamily->husband() ?? $parentFamily->wife();
            if ($parentPerson instanceof Individual) {
                if ($generation + 1 <= $this->maxGenUp) {
                    $parentNodeId = $this->collectTree(
                        $parentPerson, 1, $parentFamily, false, $xref, $generation + 1
                    );
                    $this->edges[] = [
                        'from' => $parentNodeId,
                        'to'   => $childNodeId,
                        'type' => 'parent-child',
                        'line' => 'self',
                        'lineIndex' => 0,
                        'familyXref' => $parentFamily->xref(),
                    ];
                }
                // Beyond limit: skip â€” tree icon on the card handles expansion
            } else {
                // Both parents unknown â€” show placeholder if siblings exist
                $hasSiblings = false;
                foreach ($parentFamily->children() as $child) {
                    if ($child->xref() !== $xref) {
                        $hasSiblings = true;
                        break;
                    }
                }
                if ($hasSiblings) {
                    $unknownNodeId = $this->nextNodeId();
                    $this->nodes[$unknownNodeId] = [
                        'id'        => $unknownNodeId,
                        'type'      => 'couple',
                        'person'    => $this->buildUnknownPersonData('M'),
                        'families'  => [[
                            'spouse'       => $this->buildUnknownPersonData('F'),
                            'marriageDate' => '',
                            'marriagePlace' => '',
                            'marriageQuality' => '',
                            'married'      => false,
                            'divorced'     => false,
                            'divorceDate'  => '',
                            'divorcePlace' => '',
                            'divorceQuality' => '',
                            'durationLabel' => '',
                            'hasNextRelationship' => false,
                            'familySourceCount' => 0,
                            'familyNoteCount' => 0,
                            'familyMediaCount' => 0,
                            'familyUrl'    => '',
                            'familyXref'   => $parentFamily->xref(),
                            'spouseHasParents' => false,
                            'spouseParentFamilyXref' => '',
                            'husbandAgeAtMarriage' => null,
                            'wifeAgeAtMarriage' => null,
                        ]],
                        'isOrigin'  => false,
                        'direction' => 1,
                        'generation' => $generation + 1,
                        'hasMultipleAncestorLines' => false,
                        'ancestorLines' => [],
                        'activeAncestorLine' => 0,
                        'personHasParents' => false,
                        'childBirthJd' => 0,
                        'originalChildXref' => '',
                        'isUnknown' => true,
                    ];
                    $this->edges[] = [
                        'from' => $unknownNodeId,
                        'to'   => $childNodeId,
                        'type' => 'parent-child',
                        'line' => 'self',
                        'lineIndex' => 0,
                        'familyXref' => $parentFamily->xref(),
                    ];
                    $this->collectSiblings($parentFamily, $xref, $unknownNodeId, 0, $generation + 1);
                }
            }
        }

        // Spouse parent families â€” one ancestor line per spouse family,
        // using the same marriage-date order as the rendered spouse cards.
        $spouseFamilies = $person->spouseFamilies()->toArray();
        usort($spouseFamilies, [$this, 'compareByMarriageDate']);

        foreach ($spouseFamilies as $spouseFamilyIndex => $spFam) {
            if ($throughFamily instanceof Family && $spFam->xref() !== $throughFamily->xref()) {
                continue;
            }

            $spouse = $spFam->spouse($person);
            if (!$spouse instanceof Individual) {
                continue;
            }

            $lineIndex = $spouseFamilyIndex + 1;
            $spParentFam = $this->bestParentFamily($spouse);
            if (!$spParentFam instanceof Family) {
                continue;
            }

            $spParent = $spParentFam->husband() ?? $spParentFam->wife();
            if ($spParent instanceof Individual) {
                if ($generation + 1 <= $this->maxGenUp) {
                    $spParentNodeId = $this->collectTree(
                        $spParent, 1, $spParentFam, false, $spouse->xref(), $generation + 1
                    );
                    $this->edges[] = [
                        'from' => $spParentNodeId,
                        'to'   => $childNodeId,
                        'type' => 'parent-child',
                        'line' => 'spouse',
                        'lineIndex' => $lineIndex,
                        'familyXref' => $spParentFam->xref(),
                    ];
                }
                // Beyond limit: skip â€” tree icon on the card handles expansion
            } else {
                // Both spouse's parents unknown â€” show placeholder if siblings exist
                $spHasSiblings = false;
                foreach ($spParentFam->children() as $ch) {
                    if ($ch->xref() !== $spouse->xref()) {
                        $spHasSiblings = true;
                        break;
                    }
                }
                if ($spHasSiblings) {
                    $unknownNodeId = $this->nextNodeId();
                    $this->nodes[$unknownNodeId] = [
                        'id'        => $unknownNodeId,
                        'type'      => 'couple',
                        'person'    => $this->buildUnknownPersonData('M'),
                        'families'  => [[
                            'spouse'       => $this->buildUnknownPersonData('F'),
                            'marriageDate' => '',
                            'married'      => false,
                            'divorced'     => false,
                            'divorceDate'  => '',
                            'familyUrl'    => '',
                            'familyXref'   => $spParentFam->xref(),
                            'spouseHasParents' => false,
                            'spouseParentFamilyXref' => '',
                        ]],
                        'isOrigin'  => false,
                        'direction' => 1,
                        'generation' => $generation + 1,
                        'hasMultipleAncestorLines' => false,
                        'ancestorLines' => [],
                        'activeAncestorLine' => 0,
                        'personHasParents' => false,
                        'childBirthJd' => 0,
                        'originalChildXref' => '',
                        'isUnknown' => true,
                    ];
                    $this->edges[] = [
                        'from' => $unknownNodeId,
                        'to'   => $childNodeId,
                        'type' => 'parent-child',
                        'line' => 'spouse',
                        'lineIndex' => $lineIndex,
                        'familyXref' => $spParentFam->xref(),
                    ];
                    $this->collectSiblings($spParentFam, $spouse->xref(), $unknownNodeId, 0, $generation + 1);
                }
            }
        }
    }

    /**
     * Collect children nodes below a parent.
     */
    private function collectChildren(Individual $person, string $parentNodeId,
                                     ?Family $throughFamily, string $excludeXref,
                                     int $familyIndex = 0, int $generation = 0): void
    {
        $allChildren = [];
        foreach ($person->spouseFamilies() as $family) {
            if ($throughFamily instanceof Family && $family->xref() !== $throughFamily->xref()) {
                continue;
            }
            foreach ($family->children() as $child) {
                if ($excludeXref !== '' && $child->xref() === $excludeXref) {
                    continue;
                }
                $allChildren[] = $child;
            }
        }

        // Sort children by birth date (oldest first = left, unknown dates last)
        usort($allChildren, static function (Individual $a, Individual $b): int {
            $ja = $a->getBirthDate()->julianDay();
            $jb = $b->getBirthDate()->julianDay();
            if ($ja === 0 && $jb === 0) return 0;
            if ($ja === 0) return 1;
            if ($jb === 0) return -1;
            return $ja <=> $jb;
        });

        // Beyond generation limit â€” create a single lazy placeholder instead of recursing
        if (count($allChildren) > 0 && $generation - 1 < $this->maxGenDown) {
            $familyXref = $throughFamily instanceof Family ? $throughFamily->xref() : '';
            $lazyId = $this->nextNodeId();
            $this->nodes[$lazyId] = [
                'id'    => $lazyId,
                'type'  => 'lazy',
                'personXref' => $person->xref(),
                'familyXref' => $familyXref,
                'label' => I18N::translate('Show descendants'),
                'direction' => 'down',
                'generation' => $generation - 1,
            ];
            $this->edges[] = [
                'from' => $parentNodeId,
                'to'   => $lazyId,
                'type' => 'parent-child',
                'familyIndex' => $familyIndex,
            ];
            return;
        }

        foreach ($allChildren as $child) {
            $childNodeId = $this->collectTree($child, -1, null, false, '', $generation - 1);
            if ($childNodeId === '') {
                continue;
            }
            $this->edges[] = [
                'from' => $parentNodeId,
                'to'   => $childNodeId,
                'type' => 'parent-child',
                'familyIndex' => $familyIndex,
            ];
        }
    }

    /**
     * Collect sibling nodes (children of a family, excluding the path child).
     */
    private function collectSiblings(Family $family, string $excludeXref, string $parentNodeId, int $familyIndex = 0, int $generation = 0): void
    {
        $siblings = [];
        foreach ($family->children() as $child) {
            if ($excludeXref !== '' && $child->xref() === $excludeXref) {
                continue;
            }
            $siblings[] = $child;
        }

        // Sort siblings by birth date (oldest first = left, unknown dates last)
        usort($siblings, static function (Individual $a, Individual $b): int {
            $ja = $a->getBirthDate()->julianDay();
            $jb = $b->getBirthDate()->julianDay();
            if ($ja === 0 && $jb === 0) return 0;
            if ($ja === 0) return 1;
            if ($jb === 0) return -1;
            return $ja <=> $jb;
        });

        foreach ($siblings as $child) {
            $siblingNodeId = $this->collectTree($child, -1, null, false, '', $generation);
            if ($siblingNodeId === '') {
                continue;
            }
            $this->edges[] = [
                'from' => $parentNodeId,
                'to'   => $siblingNodeId,
                'type' => 'parent-child',
                'familyIndex' => $familyIndex,
            ];
        }
    }

    /**
     * Compare two families by marriage date for sorting (oldest first).
     */
    private function compareByMarriageDate(Family $a, Family $b): int
    {
        $aDate = 0;
        $bDate = 0;
        foreach ($a->facts(Gedcom::MARRIAGE_EVENTS, true) as $fact) {
            if ($fact->tag() === 'FAM:MARR') {
                $d = $fact->date()->julianDay();
                if ($d > 0) {
                    $aDate = $d;
                    break;
                }
            }
        }
        foreach ($b->facts(Gedcom::MARRIAGE_EVENTS, true) as $fact) {
            if ($fact->tag() === 'FAM:MARR') {
                $d = $fact->date()->julianDay();
                if ($d > 0) {
                    $bDate = $d;
                    break;
                }
            }
        }

        if ($aDate !== $bDate) {
            if ($aDate === 0) {
                return 1;
            }
            if ($bDate === 0) {
                return -1;
            }
            return $aDate <=> $bDate;
        }

        // Stable tie-breaker so spouse/family order stays deterministic across page loads and AJAX calls.
        return strcmp($a->xref(), $b->xref());
    }

    /**
     * Extract date quality and place from a fact GEDCOM snippet.
     * @return array{quality:string, place:string}
     */
    private function extractEventMeta(string $factGedcom): array
    {
        $rawDate = '';
        if (preg_match('/\n2 DATE\s+([^\r\n]+)/', $factGedcom, $m)) {
            $rawDate = trim($m[1]);
        }

        $place = '';
        if (preg_match('/\n2 PLAC\s+([^\r\n]+)/', $factGedcom, $m)) {
            $place = trim($m[1]);
        }

        $quality = 'unknown';
        if ($rawDate !== '') {
            if (preg_match('/\b(ABT|ABOUT|CAL|EST)\b/i', $rawDate)) {
                $quality = 'approx';
            } elseif (preg_match('/\b(BEF|AFT|BET|AND|FROM|TO)\b/i', $rawDate)) {
                $quality = 'range';
            } else {
                $quality = 'exact';
            }
        }

        return [
            'quality' => $quality,
            'place' => $place,
        ];
    }

    /**
     * Merge two quality markers into one badge for the main date line.
     */
    private function mergeDateQuality(string $a, string $b): string
    {
        $ordered = ['range', 'approx', 'exact', 'unknown'];
        foreach ($ordered as $q) {
            if ($a === $q || $b === $q) {
                return $q;
            }
        }

        return 'unknown';
    }

    /**
     * Count occurrences of a GEDCOM tag at any level within a record.
     */
    private function countAllTags(string $gedcom, string $tag): int
    {
        if ($gedcom === '') {
            return 0;
        }

        return preg_match_all('/\n\d+\s+' . preg_quote($tag, '/') . '\b/', $gedcom);
    }

    /**
     * Find first valid marriage date (Julian day) in a family.
     */
    private function firstMarriageJulianDay(Family $family): int
    {
        foreach ($family->facts(Gedcom::MARRIAGE_EVENTS, true) as $fact) {
            if ($fact->tag() !== 'FAM:MARR') {
                continue;
            }

            $jd = $fact->date()->julianDay();
            if ($jd > 0) {
                return $jd;
            }
        }

        return 0;
    }

    /**
     * Build compact relationship duration label (e.g. "12y 3m").
     */
    private function formatRelationshipDuration(int $startJd, int $endJd, int $fallbackEndJd, int $personDeathJd = 0, int $spouseDeathJd = 0): string
    {
        if ($startJd <= 0) {
            return '';
        }

        $effectiveEndJd = 0;
        if ($endJd > 0) {
            // Divorce date exists â€” use it
            $effectiveEndJd = $endJd;
        } elseif ($fallbackEndJd > 0) {
            // Next marriage date as fallback
            $effectiveEndJd = $fallbackEndJd;
        } elseif ($personDeathJd > 0 && $spouseDeathJd > 0) {
            // Both dead, no divorce â€” use the earlier death date
            $effectiveEndJd = min($personDeathJd, $spouseDeathJd);
        } elseif ($personDeathJd > 0 || $spouseDeathJd > 0) {
            // One dead â€” marriage lasted until that death
            $effectiveEndJd = max($personDeathJd, $spouseDeathJd);
        } elseif ($personDeathJd === 0 && $spouseDeathJd === 0) {
            // Both alive â€” duration until today
            $effectiveEndJd = (int) gregoriantojd((int) date('n'), (int) date('j'), (int) date('Y'));
        } else {
            // Insufficient data â€” do not calculate
            return '';
        }

        $days = max(0, $effectiveEndJd - $startJd);
        if ($days === 0) {
            return '';
        }

        $years = (int) floor($days / 365.2425);
        $months = (int) floor(($days - ($years * 365.2425)) / 30.436875);

        if ($years > 0 && $months > 0) {
            return I18N::translate('%sy %sm', (string) $years, (string) $months);
        }
        if ($years > 0) {
            return I18N::translate('%sy', (string) $years);
        }

        return I18N::translate('%sm', (string) max(1, $months));
    }

    // --- AJAX response builders ---

    /**
     * Expand a node: return JSON subtree data via AJAX.
     */
    public function expandNode(string $familyId, string $personId, Tree $tree, int $generation = 0): string
    {
        $family = Registry::familyFactory()->make($familyId, $tree);
        if (!$family instanceof Family || !$family->canShow()) {
            return json_encode(['nodes' => [], 'edges' => []]);
        }
        $person = $family->husband() ?? $family->wife();
        if (!$person instanceof Individual || !$person->canShow()) {
            return json_encode(['nodes' => [], 'edges' => []]);
        }

        $this->nodes = [];
        $this->edges = [];
        $this->visited = [];

        // Load exactly 1 ancestor generation per click (tree icon handles further expansion)
        $this->maxGenUp = $generation;
        $this->maxGenDown = $generation - 3;

        // personId = xref of the child whose parents we're expanding (to exclude from siblings)
        $rootId = $this->collectTree($person, 1, $family, false, $personId, $generation);

        // Save updated counter for subsequent AJAX calls
        $this->saveNodeIdCounter();

        return json_encode([
            'nodes' => array_values($this->nodes),
            'edges' => $this->edges,
            'rootId' => $rootId,
        ], JSON_UNESCAPED_UNICODE);
    }

    /**
     * Navigate to a person: return full tree JSON centered on them.
     */
    public function navigateTo(string $xref, Tree $tree): string
    {
        $person = Registry::individualFactory()->make($xref, $tree);
        if (!$person instanceof Individual || !$person->canShow()) {
            return json_encode(['nodes' => [], 'edges' => [], 'rootId' => null]);
        }

        $this->nodes = [];
        $this->edges = [];
        $this->visited = [];
        $this->nodeIdCounter = 0;

        $rootId = $this->collectTree($person, 0, null, true, '');

        $this->saveNodeIdCounter();

        return json_encode([
            'nodes' => array_values($this->nodes),
            'edges' => $this->edges,
            'rootId' => $rootId,
        ], JSON_UNESCAPED_UNICODE);
    }

    /**
     * Expand descendants: return child subtrees via AJAX.
     */
    public function expandDescendants(string $personXref, string $familyXref, Tree $tree, int $generation = 0): string
    {
        $person = Registry::individualFactory()->make($personXref, $tree);
        if (!$person instanceof Individual || !$person->canShow()) {
            return json_encode(['nodes' => [], 'edges' => [], 'childRootIds' => []]);
        }

        $family = ($familyXref !== '') ? Registry::familyFactory()->make($familyXref, $tree) : null;

        $this->nodes = [];
        $this->edges = [];
        $this->visited = [];

        // Load exactly 1 generation of children per click (lazy placeholder handles further expansion)
        $this->maxGenDown = $generation;

        // Collect children of the person from the matching family
        $allChildren = [];
        foreach ($person->spouseFamilies() as $fam) {
            if ($family instanceof Family && $fam->xref() !== $family->xref()) {
                continue;
            }
            foreach ($fam->children() as $child) {
                $allChildren[] = $child;
            }
        }

        usort($allChildren, static function (Individual $a, Individual $b): int {
            $ja = $a->getBirthDate()->julianDay();
            $jb = $b->getBirthDate()->julianDay();
            if ($ja === 0 && $jb === 0) return 0;
            if ($ja === 0) return 1;
            if ($jb === 0) return -1;
            return $ja <=> $jb;
        });

        $childRootIds = [];
        foreach ($allChildren as $child) {
            $childNodeId = $this->collectTree($child, -1, null, false, '', $generation);
            if ($childNodeId !== '') {
                $childRootIds[] = $childNodeId;
            }
        }

        $this->saveNodeIdCounter();

        return json_encode([
            'nodes' => array_values($this->nodes),
            'edges' => $this->edges,
            'childRootIds' => $childRootIds,
        ], JSON_UNESCAPED_UNICODE);
    }

    /**
     * Search persons matching a query â€” returns JSON for autocomplete.
     */
    public function searchPersons(Tree $tree, string $prefix, string $query): string
    {
        $results = [];

        if (strlen($query) < 2) {
            return json_encode($results);
        }

        $words = preg_split('/\s+/', $query, -1, PREG_SPLIT_NO_EMPTY);
        $seen  = [];

        // --- Pass 1: strict AND â€” every word must appear ----------------
        $dbQuery = DB::table('individuals')->where('i_file', '=', $tree->id());
        foreach ($words as $word) {
            $ascii = self::stripDiacritics($word);
            if ($ascii !== $word) {
                $p1 = '%' . addcslashes($word, '\\%_') . '%';
                $p2 = '%' . addcslashes($ascii, '\\%_') . '%';
                $dbQuery->where(static function ($q) use ($p1, $p2) {
                    $q->where('i_gedcom', 'LIKE', $p1)
                      ->orWhere('i_gedcom', 'LIKE', $p2);
                });
            } else {
                $dbQuery->where('i_gedcom', 'LIKE', '%' . addcslashes($word, '\\%_') . '%');
            }
        }
        foreach ($dbQuery->limit(20)->get() as $row) {
            $seen[$row->i_id] = true;
            $this->pushSearchResult($results, $row, $tree);
        }

        // --- Pass 2: prefix / fuzzy fallback if few results -------------
        if (count($results) < 10) {
            $dbQuery2 = DB::table('individuals')->where('i_file', '=', $tree->id());
            $dbQuery2->where(static function ($outer) use ($words) {
                foreach ($words as $word) {
                    $prefix3 = mb_substr($word, 0, 3);
                    $ascii   = self::stripDiacritics($prefix3);
                    $outer->orWhere('i_gedcom', 'LIKE', '%' . addcslashes($prefix3, '\\%_') . '%');
                    if ($ascii !== $prefix3) {
                        $outer->orWhere('i_gedcom', 'LIKE', '%' . addcslashes($ascii, '\\%_') . '%');
                    }
                }
            });
            $remaining = 20 - count($results);
            foreach ($dbQuery2->limit($remaining + count($seen))->get() as $row) {
                if (!isset($seen[$row->i_id])) {
                    $seen[$row->i_id] = true;
                    $this->pushSearchResult($results, $row, $tree);
                    if (count($results) >= 20) break;
                }
            }
        }

        // --- Rank: exact full-name hits first ---------------------------
        $lowerQuery = mb_strtolower($query);
        usort($results, static function ($a, $b) use ($lowerQuery) {
            $aPos = mb_strpos(mb_strtolower($a['name']), $lowerQuery);
            $bPos = mb_strpos(mb_strtolower($b['name']), $lowerQuery);
            $aExact = $aPos !== false ? 0 : 1;
            $bExact = $bPos !== false ? 0 : 1;
            return $aExact <=> $bExact ?: ($aPos ?? 999) <=> ($bPos ?? 999);
        });

        return json_encode($results, JSON_UNESCAPED_UNICODE);
    }

    private function pushSearchResult(array &$results, object $row, Tree $tree): void
    {
        $individual = Registry::individualFactory()->make($row->i_id, $tree);
        if ($individual instanceof Individual && $individual->canShowName()) {
            $results[] = [
                'xref'  => $individual->xref(),
                'name'  => strip_tags($individual->fullName()),
                'years' => strip_tags($individual->lifespan()),
            ];
        }
    }

    private static function stripDiacritics(string $text): string
    {
        if (function_exists('transliterator_transliterate')) {
            return transliterator_transliterate('Any-Latin; Latin-ASCII', $text);
        }
        $map = ['Ă '=>'a','Ăˇ'=>'a','Ă˘'=>'a','ĂŁ'=>'a','Ă¤'=>'a','ĂĄ'=>'a','Ä…'=>'a',
                 'Ä‡'=>'c','ÄŤ'=>'c','Ă§'=>'c','Ă¨'=>'e','Ă©'=>'e','ĂŞ'=>'e','Ă«'=>'e','Ä™'=>'e',
                 'Ă¬'=>'i','Ă­'=>'i','Ă®'=>'i','ĂŻ'=>'i','Ĺ‚'=>'l','Ă±'=>'n','Ĺ„'=>'n',
                 'Ă˛'=>'o','Ăł'=>'o','Ă´'=>'o','Ăµ'=>'o','Ă¶'=>'o','Ă¸'=>'o',
                 'Ĺ›'=>'s','Ĺˇ'=>'s','Ăą'=>'u','Ăş'=>'u','Ă»'=>'u','ĂĽ'=>'u',
                 'Ă˝'=>'y','Ăż'=>'y','Ĺş'=>'z','ĹĽ'=>'z','Ĺľ'=>'z',
                 'Ă€'=>'A','Ă'=>'A','Ă‚'=>'A','Ă'=>'A','Ă„'=>'A','Ă…'=>'A','Ä„'=>'A',
                 'Ä†'=>'C','ÄŚ'=>'C','Ă‡'=>'C','Ă'=>'E','Ă‰'=>'E','ĂŠ'=>'E','Ă‹'=>'E','Ä'=>'E',
                 'ĂŚ'=>'I','ĂŤ'=>'I','ĂŽ'=>'I','ĂŹ'=>'I','Ĺ'=>'L','Ă‘'=>'N','Ĺ'=>'N',
                 'Ă’'=>'O','Ă“'=>'O','Ă”'=>'O','Ă•'=>'O','Ă–'=>'O','Ă'=>'O',
                 'Ĺš'=>'S','Ĺ '=>'S','Ă™'=>'U','Ăš'=>'U','Ă›'=>'U','Ăś'=>'U',
                 'Ăť'=>'Y','Ĺą'=>'Z','Ĺ»'=>'Z','Ĺ˝'=>'Z'];
        return strtr($text, $map);
    }

}
