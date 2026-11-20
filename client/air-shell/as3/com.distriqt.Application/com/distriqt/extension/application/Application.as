// The Reflipped app's own ActionScript side of the "com.distriqt.Application" native extension, written from the game's
// call sites, not from the original wrapper. GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package com.distriqt.extension.application {
    import flash.events.EventDispatcher;
    import flash.external.ExtensionContext;

    /**
     * The game reads Application.isSupported and, only when it is true, Application.service.device.locale.language.
     * Our Java stub (DistriqtApplicationStub) answers isSupported with false, so the device object is a placeholder
     * whose locale is null.
     */
    public class Application extends EventDispatcher {
        public static const EXT_CONTEXT_ID:String = "com.distriqt.Application";
        public static const VERSION:String = "reflipped";

        private static var context:ExtensionContext;
        private static var instance:Application;

        public static function init(key:String = null):void {
            service;
        }

        public static function get isSupported():Boolean {
            return call("isSupported") === true;
        }

        public static function get service():Application {
            if (instance == null) instance = new Application();
            return instance;
        }

        private static function open():ExtensionContext {
            if (context == null) context = ExtensionContext.createExtensionContext(EXT_CONTEXT_ID, null);
            return context;
        }

        /** A native call, or null when the context or the function is missing (Error #3500), as the stubs answer. */
        private static function call(name:String, ...args):* {
            var c:ExtensionContext = open();
            if (c == null) return null;
            args.unshift(name);
            try {
                return c.call.apply(c, args);
            } catch (e:ArgumentError) {
            }
            return null;
        }

        public function Application() {
            open();
        }

        public function get version():String { return VERSION; }
        public function get nativeVersion():String { return "0"; }
        public function get implementation():String { return "reflipped"; }

        /** Untyped on purpose: the game's own Device and Locale classes stay the game's. */
        public function get device():Object {
            return {locale: null};
        }

        public function dispose():void {
            if (context != null) context.dispose();
            context = null;
            instance = null;
        }
    }
}
