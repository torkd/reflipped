// The Reflipped app's own ActionScript side of the "com.distriqt.Core" native extension, written from the game's call
// sites, not from the original wrapper. GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package com.distriqt.extension.core {
    import flash.events.EventDispatcher;
    import flash.external.ExtensionContext;

    /**
     * The game only calls Core.init() and Core.init(key). That opens the native context, as the other distriqt
     * extensions expect; our Java stub (DistriqtCoreStub) registers no functions and nothing here calls one.
     */
    public class Core extends EventDispatcher {
        public static const EXT_CONTEXT_ID:String = "com.distriqt.Core";
        public static const VERSION:String = "reflipped";

        private static var context:ExtensionContext;
        private static var instance:Core;

        public static function init(key:String = null):void {
            service;
        }

        public static function get isSupported():Boolean {
            return open() != null;
        }

        public static function get service():Core {
            if (instance == null) instance = new Core();
            return instance;
        }

        private static function open():ExtensionContext {
            if (context == null) context = ExtensionContext.createExtensionContext(EXT_CONTEXT_ID, null);
            return context;
        }

        public function Core() {
            open();
        }

        public function get version():String { return VERSION; }
        public function get nativeVersion():String { return "0"; }
        public function get implementation():String { return "reflipped"; }

        public function dispose():void {
            if (context != null) context.dispose();
            context = null;
            instance = null;
        }
    }
}
