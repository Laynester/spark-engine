import { EventBus } from "./EventBus";

/**
 * Global Spark API instance.
 * Game scripts can `import { spark } from "@spark/runtime"` and use:
 *   spark.on("ready", () => { ... })  - fires when the runtime starts
 *   spark.on("update", (dt) => { ... }) - fires every frame
 *   spark.spawn(config) - spawn an entity
 *   spark.destroy(entity) - destroy an entity
 *   spark.import(name) - cross-package import
 *   spark.emit(...) / spark.once(...) - event helpers
 *
 * The SparkRuntime hooks into this automatically when created.
 */
export const spark = new EventBus();
