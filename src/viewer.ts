import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";

/**
 * Headless-optimized BIM viewer.
 * No UI chrome — all interaction is programmatic via methods.
 * Uses preserveDrawingBuffer for screenshot capture.
 */
export class BIMViewer {
    components!: OBC.Components;
    world!: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
    fragments!: OBC.FragmentsManager;
    ifcLoader!: OBC.IfcLoader;
    indexer!: OBC.IfcRelationsIndexer;
    raycaster!: OBC.Raycasters;
    clipper!: OBC.Clipper;
    boundingBoxer!: OBC.BoundingBoxer;
    classifier!: OBC.Classifier;
    hider!: OBC.Hider;
    grids!: OBC.Grids;
    viewpoints!: OBC.Viewpoints;
    bcfTopics!: OBC.BCFTopics;
    exploder!: OBC.Exploder;
    measureUtils!: OBC.MeasurementUtils;
    plans!: OBCF.Plans;

    private container: HTMLElement;
    private loadedModels: Map<string, FRAGS.FragmentsGroup> = new Map();
    private _originalMaterials: Map<string, THREE.Material | THREE.Material[]> = new Map();
    private _nativeClipPlanes: THREE.Plane[] = [];

    constructor(container: HTMLElement) {
        this.container = container;
    }

    async init(): Promise<void> {
        // ── Core Components ─────────────────────────────────────
        this.components = new OBC.Components();

        // ── World (Scene + Camera + Renderer) ───────────────────
        const worlds = this.components.get(OBC.Worlds);
        this.world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();

        // Scene
        this.world.scene = new OBC.SimpleScene(this.components);
        this.world.scene.setup();

        // Renderer with preserveDrawingBuffer for screenshots
        this.world.renderer = new OBC.SimpleRenderer(this.components, this.container, {
            preserveDrawingBuffer: true,
            antialias: true,
            alpha: false,
        } as any);

        // Camera (OrthoPerspectiveCamera supports ortho/persp projection + navigation modes)
        this.world.camera = new OBC.OrthoPerspectiveCamera(this.components);
        this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

        // ── Initialize ──────────────────────────────────────────
        this.components.init();

        // ── Fragments Manager ───────────────────────────────────
        this.fragments = this.components.get(OBC.FragmentsManager);

        // ── IFC Loader ──────────────────────────────────────────
        this.ifcLoader = this.components.get(OBC.IfcLoader);
        await this.ifcLoader.setup();

        // ── Relations Indexer ────────────────────────────────────
        this.indexer = this.components.get(OBC.IfcRelationsIndexer);

        // ── Raycaster ───────────────────────────────────────────
        this.raycaster = this.components.get(OBC.Raycasters);
        this.raycaster.get(this.world);

        // ── Clipper ──────────────────────────────────────────────
        this.clipper = this.components.get(OBC.Clipper);
        this.clipper.enabled = true;

        // ── Bounding Boxer ──────────────────────────────────────
        this.boundingBoxer = this.components.get(OBC.BoundingBoxer);

        // ── Classifier ──────────────────────────────────────────
        this.classifier = this.components.get(OBC.Classifier);

        // ── Hider ───────────────────────────────────────────────
        this.hider = this.components.get(OBC.Hider);

        // ── Grids ───────────────────────────────────────────────
        this.grids = this.components.get(OBC.Grids);
        this.grids.create(this.world);

        // ── Viewpoints (BCF) ─────────────────────────────────────
        this.viewpoints = this.components.get(OBC.Viewpoints);

        // ── BCF Topics ───────────────────────────────────────────
        this.bcfTopics = this.components.get(OBC.BCFTopics);

        // ── Exploder ─────────────────────────────────────────────
        this.exploder = this.components.get(OBC.Exploder);

        // ── Measurement Utilities ────────────────────────────────
        this.measureUtils = this.components.get(OBC.MeasurementUtils);

        // ── Plans (2D floor plans) ───────────────────────────────
        this.plans = this.components.get(OBCF.Plans);
        this.plans.world = this.world;

        // ── Scene lighting ──────────────────────────────────────
        const scene = this.world.scene.three;
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambient);
        const directional = new THREE.DirectionalLight(0xffffff, 1.5);
        directional.position.set(50, 80, 50);
        scene.add(directional);

        console.log("[RL-BIM] Viewer initialized with all components");
    }

    // ═══════════════════════════════════════════════════════════
    // Model Loading
    // ═══════════════════════════════════════════════════════════

    async loadModel(url: string): Promise<{ modelId: string; elementCount: number }> {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);

        const model = await this.ifcLoader.load(data);
        this.world.scene.three.add(model);

        const modelId = crypto.randomUUID();
        this.loadedModels.set(modelId, model);

        // Index relations (required for spatial classification)
        try {
            await this.indexer.process(model);
        } catch (e) {
            console.warn("[RL-BIM] Relations indexing failed (non-critical):", e);
        }

        // Classify for spatial queries
        try {
            this.classifier.byEntity(model);
            await this.classifier.bySpatialStructure(model);
            this.classifier.byModel(model.uuid, model);
        } catch (e) {
            console.warn("[RL-BIM] Classification partially failed (non-critical):", e);
        }

        // Count elements
        let elementCount = 0;
        for (const frag of model.items) {
            elementCount += frag.ids.size;
        }

        console.log(`[RL-BIM] Loaded model ${modelId}: ${elementCount} elements`);
        return { modelId, elementCount };
    }

    // ═══════════════════════════════════════════════════════════
    // Screenshot Capture
    // ═══════════════════════════════════════════════════════════

    async captureScreenshot(width?: number, height?: number): Promise<string> {
        const renderer = this.world.renderer!.three;
        const scene = this.world.scene.three;
        const camera = this.world.camera.three;
        const canvas = renderer.domElement;

        // Wait for next animation frame to ensure scene is ready
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                // Force a render within the animation frame
                renderer.render(scene, camera);
                resolve();
            });
        });

        // Wait one more frame so the buffer is fully flushed
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });

        const targetW = width || Math.min(canvas.width, 768);
        const targetH = height || Math.min(canvas.height, 512);

        const offscreen = document.createElement("canvas");
        offscreen.width = targetW;
        offscreen.height = targetH;
        const ctx = offscreen.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0, targetW, targetH);
        return offscreen.toDataURL("image/jpeg", 0.85);
    }

    // ═══════════════════════════════════════════════════════════
    // Camera Controls
    // ═══════════════════════════════════════════════════════════

    async orbitCamera(azimuthDeg: number, polarDeg: number): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.rotate(
            THREE.MathUtils.degToRad(azimuthDeg),
            THREE.MathUtils.degToRad(polarDeg),
            true
        );
    }

    async panCamera(dx: number, dy: number): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.truck(dx, dy, true);
    }

    async zoomCamera(factor: number): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.dolly(factor, true);
    }

    async walkForward(distance: number): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.forward(distance, true);
    }

    async elevateCamera(height: number): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.elevate(height, true);
    }

    async setCameraPosition(
        x: number, y: number, z: number,
        tx: number, ty: number, tz: number
    ): Promise<void> {
        const controls = this.world.camera.controls;
        await controls.setLookAt(x, y, z, tx, ty, tz, true);
    }

    getCameraState(): {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
    } {
        const pos = new THREE.Vector3();
        const target = new THREE.Vector3();
        this.world.camera.controls.getPosition(pos);
        this.world.camera.controls.getTarget(target);
        return {
            position: { x: pos.x, y: pos.y, z: pos.z },
            target: { x: target.x, y: target.y, z: target.z },
        };
    }

    async resetView(): Promise<void> {
        // Fit all loaded models
        this.boundingBoxer.reset();
        for (const [, model] of this.loadedModels) {
            this.boundingBoxer.add(model);
        }
        const sphere = this.boundingBoxer.getSphere();
        const center = sphere.center;
        const radius = sphere.radius || 20;

        await this.world.camera.controls.setLookAt(
            center.x + radius * 1.5,
            center.y + radius * 1.5,
            center.z + radius * 1.5,
            center.x,
            center.y,
            center.z,
            true
        );
    }

    async setCameraProjection(mode: "Perspective" | "Orthographic"): Promise<void> {
        const cam = this.world.camera as OBC.OrthoPerspectiveCamera;
        await cam.projection.set(mode);
    }

    setNavigationMode(mode: "Orbit" | "FirstPerson" | "Plan"): void {
        const cam = this.world.camera as OBC.OrthoPerspectiveCamera;
        cam.set(mode);
    }

    // ═══════════════════════════════════════════════════════════
    // BCF Viewpoints & Topics
    // ═══════════════════════════════════════════════════════════

    createViewpoint(title?: string): { guid: string; title?: string } {
        const vp = this.viewpoints.create(this.world);
        if (title) vp.title = title;
        return { guid: vp.guid, title: vp.title };
    }

    listViewpoints(): Array<{ guid: string; title?: string; position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }> {
        const result: Array<{ guid: string; title?: string; position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }> = [];
        for (const [, vp] of this.viewpoints.list) {
            const pos = vp.position;
            const dir = vp.direction;
            result.push({
                guid: vp.guid,
                title: vp.title,
                position: { x: pos.x, y: pos.y, z: pos.z },
                direction: { x: dir.x, y: dir.y, z: dir.z },
            });
        }
        return result;
    }

    async loadViewpoint(guid: string): Promise<{ found: boolean }> {
        const vp = this.viewpoints.list.get(guid);
        if (!vp) return { found: false };
        await vp.go(this.world, true);
        vp.applyVisibility();
        vp.applyColors();
        return { found: true };
    }

    async exportBCF(topicGuids?: string[]): Promise<string> {
        let topics: OBC.Topic[] | undefined;
        if (topicGuids && topicGuids.length > 0) {
            topics = topicGuids
                .map((g) => this.bcfTopics.list.get(g))
                .filter(Boolean) as OBC.Topic[];
        }
        const blob = await this.bcfTopics.export(topics);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    async importBCF(base64Data: string): Promise<{ topics: string[]; viewpoints: string[] }> {
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const { topics, viewpoints } = await this.bcfTopics.load(bytes, this.world);
        return {
            topics: topics.map((t) => t.guid),
            viewpoints: viewpoints.map((v) => v.guid),
        };
    }

    // ═══════════════════════════════════════════════════════════
    // Element Interaction
    // ═══════════════════════════════════════════════════════════

    async selectElement(expressId: number): Promise<{
        found: boolean;
        type?: string;
        name?: string;
    }> {
        for (const [, model] of this.loadedModels) {
            const prop = await model.getProperties(expressId);
            if (prop) {
                return {
                    found: true,
                    type: prop.type != null ? this.ifcTypeName(prop.type) : "IFC Element",
                    name: prop.Name?.value ?? `Element #${expressId}`,
                };
            }
        }
        return { found: false };
    }

    async pickElement(screenX: number = 0, screenY: number = 0): Promise<{
        found: boolean;
        expressId?: number;
        type?: string;
        name?: string;
        properties?: Record<string, any>;
    }> {
        const caster = this.raycaster.get(this.world);
        const result = caster.castRay(
            undefined,
            new THREE.Vector2(screenX, screenY),
        ) as any;

        if (!result) return { found: false };

        const expressId: number | undefined = result.localId;
        if (expressId == null) return { found: false };

        for (const [, model] of this.loadedModels) {
            const prop = await model.getProperties(expressId);
            if (prop) {
                return {
                    found: true,
                    expressId,
                    type: prop.type != null ? this.ifcTypeName(prop.type) : "IFC Element",
                    name: prop.Name?.value ?? `Element #${expressId}`,
                    properties: prop,
                };
            }
        }
        return { found: true, expressId };
    }

    async getElementProperties(expressId: number): Promise<Record<string, any> | null> {
        for (const [, model] of this.loadedModels) {
            const prop = await model.getProperties(expressId);
            if (prop) return prop;
        }
        return null;
    }

    highlightElements(expressIds: number[], color: string = "#ff6b35"): void {
        const colorObj = new THREE.Color(color);
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const matching = expressIds.filter((id) => frag.ids.has(id));
                if (matching.length > 0) {
                    const idSet = new Set(matching);
                    frag.setColor(colorObj, [...idSet]);
                }
            }
        }
    }

    clearHighlights(): void {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                frag.resetColor();
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Element Visibility
    // ═══════════════════════════════════════════════════════════

    hideByType(ifcType: string): { hidden: boolean; matchedType?: string } {
        const entities = this.classifier.list.entities;
        if (!entities) return { hidden: false };

        const matchKey = Object.keys(entities).find(
            (k) => k.toLowerCase() === ifcType.toLowerCase()
        );
        if (!matchKey) return { hidden: false };

        const entry = entities[matchKey];
        if (!entry) return { hidden: false };

        const fragIdMap = (entry as any).map ?? entry;
        this.hider.set(false, fragIdMap);
        return { hidden: true, matchedType: matchKey };
    }

    showAll(): void {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                frag.setVisibility(true);
            }
        }
    }

    hideElements(expressIds: number[]): void {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const matching = expressIds.filter((id) => frag.ids.has(id));
                if (matching.length > 0) {
                    frag.setVisibility(false, matching);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Clipping Planes (native Three.js -- avoids SimplePlane crash with OrthoPerspectiveCamera)
    // ═══════════════════════════════════════════════════════════

    private _applyClipPlanes(): void {
        const renderer = this.world.renderer!.three;
        renderer.clippingPlanes = this._nativeClipPlanes;
        renderer.localClippingEnabled = true;
    }

    createClipPlane(
        normalX: number, normalY: number, normalZ: number,
        offset: number
    ): string {
        const normal = new THREE.Vector3(normalX, normalY, normalZ).normalize();
        const plane = new THREE.Plane(normal, -offset);
        this._nativeClipPlanes.push(plane);
        this._applyClipPlanes();
        return "clip-plane-created";
    }

    removeAllClipPlanes(): void {
        this._nativeClipPlanes.length = 0;
        this._applyClipPlanes();
    }

    // ═══════════════════════════════════════════════════════════
    // Smart Navigation
    // ═══════════════════════════════════════════════════════════

    async focusElement(expressId: number): Promise<{ found: boolean }> {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                if (!frag.ids.has(expressId)) continue;

                const mesh = frag.mesh;
                const box = new THREE.Box3().setFromObject(mesh);

                if (box.isEmpty()) continue;

                const controls = this.world.camera.controls;
                await controls.fitToBox(box, true, { paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 });
                return { found: true };
            }
        }
        return { found: false };
    }

    getModelBounds(): {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
        center: { x: number; y: number; z: number };
        size: { x: number; y: number; z: number };
    } | null {
        this.boundingBoxer.reset();
        for (const [, model] of this.loadedModels) {
            this.boundingBoxer.add(model);
        }
        const box = this.boundingBoxer.get();
        if (box.isEmpty()) return null;

        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);

        return {
            min: { x: box.min.x, y: box.min.y, z: box.min.z },
            max: { x: box.max.x, y: box.max.y, z: box.max.z },
            center: { x: center.x, y: center.y, z: center.z },
            size: { x: size.x, y: size.y, z: size.z },
        };
    }

    // ═══════════════════════════════════════════════════════════
    // Spatial Queries
    // ═══════════════════════════════════════════════════════════

    async searchElements(query: string, ifcType?: string): Promise<Array<{
        expressId: number;
        type: string;
        name: string;
    }>> {
        const results: Array<{ expressId: number; type: string; name: string }> = [];
        const queryLower = query.toLowerCase();

        for (const [, model] of this.loadedModels) {
            const allIDs = model.getAllPropertiesIDs();

            for (const expressId of allIDs) {
                const prop = await model.getProperties(expressId);
                if (!prop) continue;

                const typeName = prop.type != null ? this.ifcTypeName(prop.type) : "";
                const name = prop.Name?.value ?? "";

                // Type filter
                if (ifcType) {
                    const ifcTypeLower = ifcType.toLowerCase();
                    if (!typeName.toLowerCase().includes(ifcTypeLower)) {
                        continue;
                    }
                }

                // Text search
                if (query) {
                    const searchable = `${name} ${typeName}`.toLowerCase();
                    if (!searchable.includes(queryLower)) continue;
                }

                results.push({
                    expressId,
                    type: typeName,
                    name: name || `#${expressId}`,
                });

                if (results.length >= 100) break;
            }
        }

        return results;
    }

    // Map IFC type numbers to human-readable names
    private ifcTypeName(typeNum: number): string {
        const IFC_TYPES: Record<number, string> = {
            // Common IFC2x3 type constants
            1281925730: "IfcSite",
            4031249490: "IfcBuilding",
            3124254112: "IfcBuildingStorey",
            3856911033: "IfcSpace",
            2391406531: "IfcWall",
            3512223829: "IfcWallStandardCase",
            2906023776: "IfcWindow",
            395920057: "IfcDoor",
            1051757585: "IfcSlab",
            2058353004: "IfcFlowTerminal",
            4278956645: "IfcFlowFitting",
            3040386961: "IfcFlowSegment",
            900683007: "IfcFooting",
            3171933400: "IfcPlate",
            1687234759: "IfcPile",
            843113511: "IfcColumn",
            3027567501: "IfcBeam",
            2740243338: "IfcCovering",
            1973544240: "IfcCovering",
            2963535650: "IfcOpeningElement",
            1529196076: "IfcRoof",
            331165859: "IfcStair",
            4252922144: "IfcStairFlight",
            979691226: "IfcStairFlight",
            4017108033: "IfcRailing",
            4156078855: "IfcCurtainWall",
            3304561284: "IfcWindow",
            3242481149: "IfcDoor",
            25142252: "IfcController",
            3588315303: "IfcOpeningElement",
            1133259667: "IfcMemberStandardCase",
            1287392070: "IfcMember",
            2571569899: "IfcFurnishingElement",
            1335981549: "IfcDiscreteAccessory",
            819618141: "IfcBeamType",
            1051575348: "IfcBuildingElementProxy",
        };
        return IFC_TYPES[typeNum] || `IfcType(${typeNum})`;
    }

    getSpatialTree(depth: number = 3): any {
        const tree: any = { type: "Project", children: [] };

        // Use classifier system groups
        const classification = this.classifier.list;
        const spatialKey = Object.keys(classification).find(
            (k) => k.toLowerCase().includes("spatial") || k.toLowerCase().includes("storey")
        );
        const spatialGroup = spatialKey ? classification[spatialKey] : null;

        if (spatialGroup) {
            for (const [name, group] of Object.entries(spatialGroup)) {
                const node: any = {
                    type: "SpatialElement",
                    name,
                    elementCount: 0,
                };

                if (depth > 1 && group) {
                    // Count elements
                    const fragMap = (group as any).map || group;
                    for (const [, idSet] of Object.entries(fragMap)) {
                        if (idSet && typeof (idSet as any).size === "number") {
                            node.elementCount += (idSet as any).size;
                        } else if (Array.isArray(idSet)) {
                            node.elementCount += (idSet as any[]).length;
                        }
                    }
                }

                tree.children.push(node);
            }
        }

        return tree;
    }

    // ═══════════════════════════════════════════════════════════
    // Classification-Driven Queries
    // ═══════════════════════════════════════════════════════════

    private _countFragmentIds(fragIdMap: FRAGS.FragmentIdMap): number {
        let count = 0;
        for (const ids of Object.values(fragIdMap)) {
            count += ids.size;
        }
        return count;
    }

    private _extractExpressIds(fragIdMap: FRAGS.FragmentIdMap): number[] {
        const ids: number[] = [];
        for (const idSet of Object.values(fragIdMap)) {
            for (const id of idSet) ids.push(id);
        }
        return ids;
    }

    getStoreys(): Array<{ name: string; id: number | null; elementCount: number }> {
        const spatial = this.classifier.list.spatialStructures;
        if (!spatial) return [];
        const result: Array<{ name: string; id: number | null; elementCount: number }> = [];
        for (const [name, group] of Object.entries(spatial)) {
            if (name.toLowerCase().includes("storey") || name.toLowerCase().includes("level") || name.toLowerCase().includes("floor")) {
                result.push({
                    name,
                    id: group.id,
                    elementCount: this._countFragmentIds(group.map),
                });
            }
        }
        if (result.length === 0) {
            for (const [name, group] of Object.entries(spatial)) {
                result.push({
                    name,
                    id: group.id,
                    elementCount: this._countFragmentIds(group.map),
                });
            }
        }
        return result;
    }

    getSpaces(): Array<{ name: string; id: number | null; elementCount: number }> {
        const spatial = this.classifier.list.spatialStructures;
        if (!spatial) return [];
        const result: Array<{ name: string; id: number | null; elementCount: number }> = [];
        for (const [name, group] of Object.entries(spatial)) {
            if (name.toLowerCase().includes("space") || name.toLowerCase().includes("room") || name.toLowerCase().includes("zone")) {
                result.push({
                    name,
                    id: group.id,
                    elementCount: this._countFragmentIds(group.map),
                });
            }
        }
        return result;
    }

    getItemsInStorey(storeyName: string): { expressIds: number[]; count: number } {
        const fragIdMap = this.classifier.find({ spatialStructures: [storeyName] });
        const expressIds = this._extractExpressIds(fragIdMap);
        return { expressIds, count: expressIds.length };
    }

    isolateStorey(storeyName: string): { success: boolean; hiddenCount: number } {
        const fragIdMap = this.classifier.find({ spatialStructures: [storeyName] });
        const keepIds = new Set(this._extractExpressIds(fragIdMap));
        if (keepIds.size === 0) return { success: false, hiddenCount: 0 };

        let hiddenCount = 0;
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const hide: number[] = [];
                const show: number[] = [];
                for (const id of frag.ids) {
                    if (keepIds.has(id)) show.push(id);
                    else hide.push(id);
                }
                if (hide.length > 0) {
                    frag.setVisibility(false, hide);
                    hiddenCount += hide.length;
                }
                if (show.length > 0) {
                    frag.setVisibility(true, show);
                }
            }
        }
        return { success: true, hiddenCount };
    }

    // ═══════════════════════════════════════════════════════════
    // Isolation, Explode, Ghost
    // ═══════════════════════════════════════════════════════════

    isolateElements(expressIds: number[]): { isolatedCount: number } {
        const keepSet = new Set(expressIds);
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const hide: number[] = [];
                const show: number[] = [];
                for (const id of frag.ids) {
                    if (keepSet.has(id)) show.push(id);
                    else hide.push(id);
                }
                if (hide.length > 0) frag.setVisibility(false, hide);
                if (show.length > 0) frag.setVisibility(true, show);
            }
        }
        return { isolatedCount: keepSet.size };
    }

    explodeModel(height: number = 10): void {
        this.exploder.height = height;
        this.exploder.groupName = "spatialStructures";
        this.exploder.set(true);
    }

    resetExplode(): void {
        this.exploder.set(false);
    }

    ghostAllExcept(expressIds: number[], alpha: number = 0.1): { ghostedMeshes: number } {
        const keepSet = new Set(expressIds);
        let ghostedMeshes = 0;

        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                let hasKeep = false;
                for (const id of frag.ids) {
                    if (keepSet.has(id)) { hasKeep = true; break; }
                }
                if (hasKeep) continue;

                const mesh = frag.mesh as any;
                const key = mesh.uuid;

                if (!this._originalMaterials.has(key)) {
                    const current = mesh.material;
                    this._originalMaterials.set(key, Array.isArray(current) ? [...current] : current);
                }

                const materials: THREE.Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                const ghosted = materials.map((mat: THREE.Material) => {
                    const clone = mat.clone();
                    clone.transparent = true;
                    clone.opacity = alpha;
                    clone.depthWrite = false;
                    return clone;
                });

                mesh.material = ghosted.length === 1 ? ghosted[0] : ghosted;
                ghostedMeshes++;
            }
        }
        return { ghostedMeshes };
    }

    resetGhost(): void {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const key = frag.mesh.uuid;
                const original = this._originalMaterials.get(key);
                if (original) {
                    (frag.mesh as any).material = original;
                }
            }
        }
        this._originalMaterials.clear();
    }

    // ═══════════════════════════════════════════════════════════
    // Enhanced Clipping
    // ═══════════════════════════════════════════════════════════

    createClipBox(
        cx: number, cy: number, cz: number,
        sx: number, sy: number, sz: number,
    ): { boxId: string; planeCount: number } {
        const halfX = sx / 2, halfY = sy / 2, halfZ = sz / 2;
        const boxId = `clipbox-${Date.now()}`;

        // 6 inward-facing planes that clip everything outside the box
        const boxPlanes: THREE.Plane[] = [
            new THREE.Plane(new THREE.Vector3(-1, 0, 0), cx + halfX),
            new THREE.Plane(new THREE.Vector3(1, 0, 0), -(cx - halfX)),
            new THREE.Plane(new THREE.Vector3(0, -1, 0), cy + halfY),
            new THREE.Plane(new THREE.Vector3(0, 1, 0), -(cy - halfY)),
            new THREE.Plane(new THREE.Vector3(0, 0, -1), cz + halfZ),
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -(cz - halfZ)),
        ];
        this._nativeClipPlanes.push(...boxPlanes);
        this._applyClipPlanes();
        return { boxId, planeCount: boxPlanes.length };
    }

    removeClipPlane(index: number): { success: boolean } {
        if (index < 0 || index >= this._nativeClipPlanes.length) return { success: false };
        this._nativeClipPlanes.splice(index, 1);
        this._applyClipPlanes();
        return { success: true };
    }

    listClipPlanes(): Array<{ index: number; normal: { x: number; y: number; z: number }; constant: number }> {
        return this._nativeClipPlanes.map((plane, index) => ({
            index,
            normal: { x: plane.normal.x, y: plane.normal.y, z: plane.normal.z },
            constant: plane.constant,
        }));
    }

    // ═══════════════════════════════════════════════════════════
    // Geometry Helpers
    // ═══════════════════════════════════════════════════════════

    getElementBBox(expressId: number): {
        found: boolean;
        min?: { x: number; y: number; z: number };
        max?: { x: number; y: number; z: number };
        center?: { x: number; y: number; z: number };
        size?: { x: number; y: number; z: number };
    } {
        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                if (!frag.ids.has(expressId)) continue;
                const box = new THREE.Box3().setFromObject(frag.mesh);
                if (box.isEmpty()) continue;
                const center = new THREE.Vector3();
                const size = new THREE.Vector3();
                box.getCenter(center);
                box.getSize(size);
                return {
                    found: true,
                    min: { x: box.min.x, y: box.min.y, z: box.min.z },
                    max: { x: box.max.x, y: box.max.y, z: box.max.z },
                    center: { x: center.x, y: center.y, z: center.z },
                    size: { x: size.x, y: size.y, z: size.z },
                };
            }
        }
        return { found: false };
    }

    raycast(screenX: number = 0, screenY: number = 0): {
        hit: boolean;
        expressId?: number;
        hitPoint?: { x: number; y: number; z: number };
        normal?: { x: number; y: number; z: number };
        distance?: number;
        ifcType?: string;
        name?: string;
    } {
        const caster = this.raycaster.get(this.world);
        const result = caster.castRay(
            undefined,
            new THREE.Vector2(screenX, screenY),
        ) as any;

        if (!result) return { hit: false };

        const expressId: number | undefined = result.localId;
        const hitPoint = result.point
            ? { x: result.point.x, y: result.point.y, z: result.point.z }
            : undefined;
        const normal = result.face?.normal
            ? { x: result.face.normal.x, y: result.face.normal.y, z: result.face.normal.z }
            : undefined;
        const distance: number | undefined = result.distance;

        return {
            hit: true,
            expressId,
            hitPoint,
            normal,
            distance,
        };
    }

    // ═══════════════════════════════════════════════════════════
    // Floor Plans (2D Views)
    // ═══════════════════════════════════════════════════════════

    async createPlanViews(): Promise<Array<{ id: string; name: string }>> {
        const result: Array<{ id: string; name: string }> = [];
        for (const [, model] of this.loadedModels) {
            try {
                await this.plans.generate(model);
            } catch (e) {
                console.warn("[RL-BIM] Plan generation partially failed:", e);
            }
        }
        for (const plan of this.plans.list) {
            result.push({ id: plan.id, name: plan.name });
        }
        return result;
    }

    listPlans(): Array<{ id: string; name: string }> {
        return this.plans.list.map((p) => ({ id: p.id, name: p.name }));
    }

    async openPlan(planId: string): Promise<{ found: boolean }> {
        const plan = this.plans.list.find((p) => p.id === planId);
        if (!plan) return { found: false };
        await this.plans.goTo(planId, true);
        return { found: true };
    }

    async exitPlan(): Promise<void> {
        await this.plans.exitPlanView(true);
    }

    // ═══════════════════════════════════════════════════════════
    // Programmatic Measurements
    // ═══════════════════════════════════════════════════════════

    measureDistance(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
    ): { distance: number } {
        const a = new THREE.Vector3(ax, ay, az);
        const b = new THREE.Vector3(bx, by, bz);
        return { distance: a.distanceTo(b) };
    }

    measureAngle(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
    ): { angleDeg: number } {
        const a = new THREE.Vector3(ax, ay, az);
        const b = new THREE.Vector3(bx, by, bz);
        const c = new THREE.Vector3(cx, cy, cz);
        const ba = a.clone().sub(b).normalize();
        const bc = c.clone().sub(b).normalize();
        const angleRad = Math.acos(Math.max(-1, Math.min(1, ba.dot(bc))));
        return { angleDeg: THREE.MathUtils.radToDeg(angleRad) };
    }

    measureVolume(expressIds: number[]): { volume: number; unit: string } {
        const fragIdMap: FRAGS.FragmentIdMap = {};
        const idSet = new Set(expressIds);

        for (const [, model] of this.loadedModels) {
            for (const frag of model.items) {
                const matching: number[] = [];
                for (const id of frag.ids) {
                    if (idSet.has(id)) matching.push(id);
                }
                if (matching.length > 0) {
                    fragIdMap[frag.id] = new Set(matching);
                }
            }
        }

        const volume = this.measureUtils.getVolumeFromFragments(fragIdMap);
        return { volume, unit: "cubic_meters" };
    }
}
