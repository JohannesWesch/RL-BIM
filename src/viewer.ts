import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import * as FRAGS from "@thatopen/fragments";

export class BIMViewer {
    components!: OBC.Components;
    world!: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
    fragments!: OBC.FragmentsManager;
    ifcLoader!: OBC.IfcLoader;
    indexer!: OBC.IfcRelationsIndexer;
    classifier!: OBC.Classifier;
    boundingBoxer!: OBC.BoundingBoxer;

    private container: HTMLElement;
    private loadedModels: Map<string, FRAGS.FragmentsGroup> = new Map();

    constructor(container: HTMLElement) {
        this.container = container;
    }

    async init(): Promise<void> {
        this.components = new OBC.Components();

        const worlds = this.components.get(OBC.Worlds);
        this.world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();

        this.world.scene = new OBC.SimpleScene(this.components);
        this.world.scene.setup();

        this.world.renderer = new OBC.SimpleRenderer(this.components, this.container, {
            preserveDrawingBuffer: true,
            antialias: true,
            alpha: false,
        } as any);

        this.world.camera = new OBC.OrthoPerspectiveCamera(this.components);
        this.world.camera.controls.setLookAt(20, 20, 20, 0, 0, 0);

        this.components.init();

        this.fragments = this.components.get(OBC.FragmentsManager);

        this.ifcLoader = this.components.get(OBC.IfcLoader);
        await this.ifcLoader.setup();

        this.indexer = this.components.get(OBC.IfcRelationsIndexer);
        this.classifier = this.components.get(OBC.Classifier);
        this.boundingBoxer = this.components.get(OBC.BoundingBoxer);

        const grids = this.components.get(OBC.Grids);
        grids.create(this.world);

        const highlighter = this.components.get(OBCF.Highlighter);
        highlighter.setup({
            world: this.world,
            autoHighlightOnClick: true,
            selectionColor: new THREE.Color("#2196F3"),
            hoverColor: new THREE.Color("#90CAF9"),
        });
        highlighter.zoomToSelection = false;

        const scene = this.world.scene.three;
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dir = new THREE.DirectionalLight(0xffffff, 1.5);
        dir.position.set(50, 80, 50);
        scene.add(dir);

        console.log("[RL-BIM] Viewer initialized");
    }

    // ═══════════════════════════════════════════════════════════
    // Model Loading
    // ═══════════════════════════════════════════════════════════

    async loadModel(url: string): Promise<{ modelId: string; elementCount: number }> {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const model = await this.ifcLoader.load(new Uint8Array(buffer));
        this.world.scene.three.add(model);

        const modelId = crypto.randomUUID();
        this.loadedModels.set(modelId, model);

        try { await this.indexer.process(model); } catch {}
        try {
            this.classifier.byEntity(model);
            await this.classifier.bySpatialStructure(model);
            this.classifier.byModel(model.uuid, model);
        } catch {}

        let elementCount = 0;
        for (const frag of model.items) elementCount += frag.ids.size;

        console.log(`[RL-BIM] Loaded model ${modelId}: ${elementCount} elements`);
        return { modelId, elementCount };
    }

    // ═══════════════════════════════════════════════════════════
    // Screenshot
    // ═══════════════════════════════════════════════════════════

    async captureScreenshot(width?: number, height?: number): Promise<string> {
        const renderer = this.world.renderer!.three;
        const scene = this.world.scene.three;
        const camera = this.world.camera.three;
        const canvas = renderer.domElement;

        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => { renderer.render(scene, camera); resolve(); });
        });
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });

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
    // Camera
    // ═══════════════════════════════════════════════════════════

    setNavigationMode(mode: "Orbit" | "FirstPerson" | "Plan"): void {
        const cam = this.world.camera as OBC.OrthoPerspectiveCamera;
        cam.set(mode);

        if (mode === "FirstPerson") {
            cam.controls.minPolarAngle = THREE.MathUtils.degToRad(10);
            cam.controls.maxPolarAngle = THREE.MathUtils.degToRad(170);
        } else {
            cam.controls.minPolarAngle = 0;
            cam.controls.maxPolarAngle = Math.PI;
        }
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
        this.boundingBoxer.reset();
        for (const [, model] of this.loadedModels) this.boundingBoxer.add(model);
        const sphere = this.boundingBoxer.getSphere();
        const c = sphere.center;
        const r = sphere.radius || 20;
        await this.world.camera.controls.setLookAt(
            c.x + r * 1.5, c.y + r * 1.5, c.z + r * 1.5,
            c.x, c.y, c.z, true,
        );
    }

    getModelBounds(): {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
        center: { x: number; y: number; z: number };
        size: { x: number; y: number; z: number };
    } | null {
        this.boundingBoxer.reset();
        for (const [, model] of this.loadedModels) this.boundingBoxer.add(model);
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
}
