/**
 * Back-compat shim for code that still imports "src/input/controller".
 * The real implementation moved to "src/input/tty-controller".
 */

export {
  
  //defaultTtyController,
  
  
} from "./tty-controller";

// Some older code referenced `defaultTtyScopes` (for convenience transitions).
// Re-export the scopes helpers via the controller to keep those imports alive.
;
