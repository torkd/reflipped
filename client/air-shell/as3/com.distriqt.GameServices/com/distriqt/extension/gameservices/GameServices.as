// The Reflipped app's own ActionScript side of the "com.distriqt.GameServices" native extension, written from the
// game's call sites, not from the original wrapper. GNU GPL version 3 with the additional permission in
// client/air-shell/LICENSE.md.
package com.distriqt.extension.gameservices {
    import flash.events.EventDispatcher;
    import flash.external.ExtensionContext;

    /**
     * The game itself only calls GameServices.init(key); the rest is a minimal "not supported" surface that forwards to our Java stub
     * (GameServicesStub), which answers false/null to everything.
     */
    public class GameServices extends EventDispatcher {
        public static const EXT_CONTEXT_ID:String = "com.distriqt.GameServices";
        public static const VERSION:String = "reflipped";

        private static var context:ExtensionContext;
        private static var instance:GameServices;

        public static function init(key:String = null):void {
            service;
        }

        public static function get isSupported():Boolean {
            return call("isSupported") === true;
        }

        public static function get service():GameServices {
            if (instance == null) instance = new GameServices();
            return instance;
        }

        private static function open():ExtensionContext {
            if (context == null) context = ExtensionContext.createExtensionContext(EXT_CONTEXT_ID, null);
            return context;
        }

        private static function call(name:String, ...args):* {
            var c:ExtensionContext = open();
            if (c == null) return null;
            args.unshift(name);
            try {
                return c.call.apply(c, args);
            } catch (e:ArgumentError) {
                // a function the native side doesn't list (Error #3500): answer "nothing"
            }
            return null;
        }

        public function GameServices() {
            open();
        }

        public function get version():String { return VERSION; }
        public function get nativeVersion():String { return String(call("version")); }
        public function get implementation():String { return String(call("implementation")); }
        public function isServiceSupported(service:String):Boolean { return call("isServiceSupported", service) === true; }
        public function initialiseService(service:*):Boolean { return call("initialiseService", service) === true; }
        public function isSignedIn():Boolean { return call("isSignedIn") === true; }
        public function signIn(options:* = null):Boolean { call("signIn", options); return false; }
        public function signOut():Boolean { call("signOut"); return false; }
        public function getPlayer():* { return call("getPlayer"); }
        public function loadPlayer():Boolean { call("loadPlayer"); return false; }
        public function disconnect():Boolean { call("disconnect"); return false; }

        public function dispose():void {
            if (context != null) context.dispose();
            context = null;
            instance = null;
        }
    }
}
