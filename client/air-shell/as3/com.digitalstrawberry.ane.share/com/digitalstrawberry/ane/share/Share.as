// The Reflipped app's own ActionScript side of the "com.digitalstrawberry.ane.share" native extension, written from the
// game's call sites, not from the original wrapper. GNU GPL version 3 with the additional permission in
// client/air-shell/LICENSE.md.
package com.digitalstrawberry.ane.share {
    import com.digitalstrawberry.ane.share.events.ShareEvent;

    import flash.events.EventDispatcher;
    import flash.events.StatusEvent;
    import flash.external.ExtensionContext;

    /**
     * The game calls Share.instance.setTitle(text) and Share.instance.share(Vector.<SharedData>). The items go to our
     * Java stub (ShareStub) as they are, and it reads each item's "data". They stay untyped, so the game's own
     * SharedData and ShareOptions classes are used as they are.
     */
    public class Share extends EventDispatcher {
        public static const EXTENSION_ID:String = "com.digitalstrawberry.ane.share";

        private static var context:ExtensionContext;
        private static var shared:Share;

        public static function get instance():Share {
            if (shared == null) shared = new Share();
            return shared;
        }

        public static function get version():String { return "reflipped"; }

        public static function get isSupported():Boolean {
            return call("isSupported") === true;
        }

        private static function open():ExtensionContext {
            if (context == null) {
                context = ExtensionContext.createExtensionContext(EXTENSION_ID, null);
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
            if (shared == null) return;
            if (event.code == ShareEvent.COMPLETE || event.code == ShareEvent.CANCEL) {
                shared.dispatchEvent(new ShareEvent(event.code, event.level));
            } else if (event.code == ShareEvent.ERROR) {
                shared.dispatchEvent(new ShareEvent(event.code, null, event.level));
            }
        }

        public function Share() {
            open();
        }

        public function setTitle(title:String):void {
            call("setTitle", title);
        }

        public function share(items:*, options:* = null):void {
            if (!isSupported) return;
            if (options == null) call("share", items);
            else call("share", items, options);
        }

        public function dispose():void {
            if (context != null) {
                context.removeEventListener(StatusEvent.STATUS, onStatus);
                context.dispose();
            }
            context = null;
            shared = null;
        }
    }
}
