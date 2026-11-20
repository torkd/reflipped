// The main SWF of the Reflipped app's import build. GNU GPL version 3 with the additional permission in
// client/air-shell/LICENSE.md.
package {
    import flash.display.Loader;
    import flash.display.Sprite;
    import flash.display.StageScaleMode;
    import flash.events.ErrorEvent;
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.events.SecurityErrorEvent;
    import flash.events.StatusEvent;
    import flash.events.UncaughtErrorEvent;
    import flash.external.ExtensionContext;
    import flash.filesystem.File;
    import flash.filesystem.FileMode;
    import flash.filesystem.FileStream;
    import flash.system.ApplicationDomain;
    import flash.system.LoaderContext;
    import flash.system.System;
    import flash.text.TextField;
    import flash.text.TextFormat;
    import flash.utils.ByteArray;
    import flash.utils.getTimer;

    import reflipped.content.ContentExtension;

    /**
     * Runs the game SWF that the app imported from the player's own game app (build.py --content import).
     *
     * 1. Asks the importer (the reflipped.content extension, java/src/reflipped/shell/content/) to get the game ready:
     *    `prepare` answers at once with a "ready" StatusEvent when the imported files are in place, and otherwise shows
     *    its own screens (import, re-patch after an app update) first.
     * 2. Reads the patched SWF from app storage and has the importer check its SHA-256 against the hash this APK
     *    ships. Code loaded with loadBytes runs with the app's full rights (files, extensions), so nothing else may
     *    run: a mismatch sends it back to `prepare`, which re-patches or imports again.
     * 3. Loads it with Loader.loadBytes and allowCodeImport into a child ApplicationDomain. Loader.load of a file URL
     *    would put it in a non-application sandbox, where the game can't use the stage or the extensions.
     *
     * The game's Haxe boot waits for the stage itself; its own code sets the scale mode, alignment and frame rate.
     */
    public class ReflippedLoader extends Sprite {
        private var context:ExtensionContext;
        private var loader:Loader;
        private var bytes:ByteArray;

        public function ReflippedLoader() {
            // The stage takes the main SWF's frame rate; the game sets its own again at start-up.
            stage.frameRate = 60;
            stage.scaleMode = StageScaleMode.NO_SCALE;
            try {
                context = ContentExtension.create();
            } catch (e:Error) {
                context = null;
            }
            if (context == null) {
                message("This build of the Reflipped app is incomplete: its game import extension is missing.");
                return;
            }
            context.addEventListener(StatusEvent.STATUS, onStatus);
            prepare("start");
        }

        private function prepare(reason:String):void {
            context.call("prepare", File.applicationStorageDirectory.nativePath, reason);
        }

        private function onStatus(e:StatusEvent):void {
            if (e.code == "ready") run(e.level);
        }

        private function run(path:String):void {
            var t0:int = getTimer();
            try {
                var game:File = new File(path);
                var stream:FileStream = new FileStream();
                stream.open(game, FileMode.READ);
                bytes = new ByteArray();
                stream.readBytes(bytes, 0, stream.bytesAvailable);
                stream.close();
            } catch (e:Error) {
                log("can't read the game: " + e.errorID);
                drop();
                prepare("unreadable");
                return;
            }
            var t1:int = getTimer();
            if (context.call("verify", bytes) !== true) {
                drop();
                prepare("damaged");
                return;
            }
            log("read " + bytes.length + " B in " + (t1 - t0) + " ms, checked in " + (getTimer() - t1) + " ms");
            var loaderContext:LoaderContext = new LoaderContext(false, new ApplicationDomain(ApplicationDomain.currentDomain));
            loaderContext.allowCodeImport = true;
            loader = new Loader();
            loader.contentLoaderInfo.addEventListener(Event.COMPLETE, onComplete);
            loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onLoadError);
            loader.contentLoaderInfo.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onLoadError);
            loader.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);
            addChildAt(loader, 0);
            loader.loadBytes(bytes, loaderContext);
        }

        private function onComplete(e:Event):void {
            drop();
            // hand the 31.7 MB the loader read back now, not at some later collection
            System.gc();
            context.call("started");
        }

        private function onLoadError(e:ErrorEvent):void {
            log("loading the game failed: " + e.type + " " + e.errorID);
            drop();
            prepare("damaged");
        }

        /** Errors the game doesn't handle itself; the release runtime would swallow them silently. */
        private function onUncaught(e:UncaughtErrorEvent):void {
            var error:Error = e.error as Error;
            log("uncaught " + (error ? error.errorID + " " + error.name + ": " + String(error.message).substr(0, 200)
                    : String(e.error).substr(0, 200)));
        }

        private function drop():void {
            if (bytes) bytes.clear();
            bytes = null;
        }

        private function log(line:String):void {
            try {
                context.call("log", line);
            } catch (e:Error) {
            }
        }

        private function message(text:String):void {
            var field:TextField = new TextField();
            field.defaultTextFormat = new TextFormat("_sans", 40, 0xFFFFFF);
            field.wordWrap = true;
            field.width = stage.stageWidth > 0 ? stage.stageWidth - 80 : 1000;
            field.height = 800;
            field.x = 40;
            field.y = 400;
            field.text = text;
            addChild(field);
        }
    }
}
