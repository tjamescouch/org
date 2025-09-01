/**
 * Back-compat shim for the old ESC/Interject controller.
 * ESC + interject handling lives inside TtyController now.
 * This file only exists so legacy imports don't crash.
 */
export {
  TtyController as EscInterjectController,
//  defaultTtyController,
  withCookedTTY,
  withRawTTY,
} from "./tty-controller";
