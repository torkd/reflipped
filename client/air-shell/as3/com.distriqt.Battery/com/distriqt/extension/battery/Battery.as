// The Reflipped app's own ActionScript side of the "com.distriqt.Battery" native extension, written from the game's call
// sites, not from the original wrapper. GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package com.distriqt.extension.battery {
    import com.distriqt.extension.battery.events.BatteryEvent;

    import flash.events.EventDispatcher;
    import flash.events.StatusEvent;
    import flash.external.ExtensionContext;

    /**
     * The game calls Battery.init(key), Battery.isSupported and Battery.service.getBatteryInfo(), and listens for
     * BatteryEvent.BATTERY_INFO on Battery.service. Our Java stub (DistriqtBatteryStub) answers isSupported,
     * getBatteryInfo and cancel, and sends the StatusEvent "battery:info" with the level "<percent>|<state>".
     */
    public class Battery extends EventDispatcher {
        public static const EXT_CONTEXT_ID:String = "com.distriqt.Battery";
        public static const VERSION:String = "reflipped";

        private static var context:ExtensionContext;
        private static var instance:Battery;

        public static function init(key:String = null):void {
            service;
        }

        public static function get isSupported():Boolean {
            return call("isSupported") === true;
        }

        public static function get service():Battery {
            if (instance == null) instance = new Battery();
            return instance;
        }

        private static function open():ExtensionContext {
            if (context == null) {
                context = ExtensionContext.createExtensionContext(EXT_CONTEXT_ID, null);
                if (context != null) context.addEventListener(StatusEvent.STATUS, onStatus);
            }
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

        private static function onStatus(event:StatusEvent):void {
            if (event.code != BatteryEvent.BATTERY_INFO || instance == null) return;
            var parts:Array = String(event.level).split("|");
            instance.dispatchEvent(new BatteryEvent(BatteryEvent.BATTERY_INFO, Number(parts[0]), int(parts[1])));
        }

        public function Battery() {
            open();
        }

        public function get version():String { return VERSION; }
        public function get nativeVersion():String { return String(call("version")); }
        public function get implementation():String { return String(call("implementation")); }

        public function getBatteryInfo():void {
            call("getBatteryInfo");
        }

        public function cancel():void {
            call("cancel");
        }

        public function dispose():void {
            if (context != null) {
                context.removeEventListener(StatusEvent.STATUS, onStatus);
                context.dispose();
            }
            context = null;
            instance = null;
        }
    }
}
