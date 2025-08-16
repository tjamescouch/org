import "./muted-colors";
import "./think-flatten";
import { installDebugHooks } from "../core/debug-hooks";
installDebugHooks().catch(e => console.warn("debug-hooks install failed:", e));
