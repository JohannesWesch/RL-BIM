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
    world!: OBC.SimpleWorld<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>;
    fragments!: OBC.FragmentsManager;
    ifcLoader!: OBC.IfcLoader;
    indexer!: OBC.IfcRelationsIndexer;
    raycaster!: OBC.Raycasters;
    clipper!: OBC.Clipper;
    boundingBoxer!: OBC.BoundingBoxer;
    classifier!: OBC.Classifier;
    hider!: OBC.Hider;
    grids!: OBC.Grids;

    private container: HTMLElement;
    private loadedModels: Map<string, FRAGS.FragmentsGroup> = new Map();

    constructor(container: HTMLElement) {
        this.container = container;
    }

    async init(): Promise<void> {
        // ── Core Components ─────────────────────────────────────
        this.components = new OBC.Components();

        // ── World (Scene + Camera + Renderer) ───────────────────
        const worlds = this.components.get(OBC.Worlds);
        this.world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();

        // Scene
        this.world.scene = new OBC.SimpleScene(this.components);
        this.world.scene.setup();

        // Renderer with preserveDrawingBuffer for screenshots
        this.world.renderer = new OBC.SimpleRenderer(this.components, this.container, {
            preserveDrawingBuffer: true,
            antialias: true,
            alpha: false,
        } as any);

        // Camera
        this.world.camera = new OBC.SimpleCamera(this.components);
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

        // Default to 1280x720 to keep file sizes manageable (~100-200KB JPEG vs 3MB PNG)
        const targetW = width || Math.min(canvas.width, 1280);
        const targetH = height || Math.min(canvas.height, 720);

        // Always use offscreen canvas for consistent sizing
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
    // Clipping Planes
    // ═══════════════════════════════════════════════════════════

    createClipPlane(
        normalX: number, normalY: number, normalZ: number,
        offset: number
    ): string {
        const normal = new THREE.Vector3(normalX, normalY, normalZ).normalize();
        const point = normal.clone().multiplyScalar(offset);

        this.clipper.createFromNormalAndCoplanarPoint(this.world, normal, point);
        return "clip-plane-created";
    }

    removeAllClipPlanes(): void {
        this.clipper.deleteAll();
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
}
