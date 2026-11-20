// The Reflipped app's own ActionScript side of the "com.distriqt.InAppBilling" native extension, written from the
// game's call sites, not from the original wrapper. GNU GPL version 3 with the additional permission in
// client/air-shell/LICENSE.md.
package com.distriqt.extension.inappbilling {
    import flash.events.EventDispatcher;
    import flash.external.ExtensionContext;

    /**
     * Reflipped has no purchases: our Java stub
     * (InAppBillingStub) answers isSupported = false, and every call here is a forward that returns "nothing".
     * Surface: the static init/isSupported/service the game uses, and the service methods its store code calls
     * (setup, getProducts, getPurchases, getPendingPurchases, finishPurchase, consumePurchase, makePurchase,
     * dispose, ...). Data objects stay untyped so the game's own Product/Purchase classes are never needed here.
     */
    public class InAppBilling extends EventDispatcher {
        public static const EXT_CONTEXT_ID:String = "com.distriqt.InAppBilling";
        public static const VERSION:String = "reflipped";

        private static var context:ExtensionContext;
        private static var instance:InAppBilling;

        public static function init(key:String = null):void {
            service;
        }

        public static function get isSupported():Boolean {
            return call("isSupported") === true;
        }

        public static function get service():InAppBilling {
            if (instance == null) instance = new InAppBilling();
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

        public function InAppBilling() {
            open();
        }

        public function get version():String { return VERSION; }
        public function get nativeVersion():String { return String(call("version")); }
        public function get implementation():String { return String(call("implementation")); }
        public function get canMakePayments():Boolean { return call("canMakePayments") === true; }
        public function get activeProducts():Array { return []; }
        public function get activeProductIds():Array { return []; }
        public function get isProductViewSupported():Boolean { return false; }
        public function get isProductOverlaySupported():Boolean { return false; }
        public function get isChangePurchaseSupported():Boolean { return false; }
        public function get isGetPurchasesSupported():Boolean { return false; }
        public function setServiceType(type:String):String { return type; }
        public function setup(service:* = null):Boolean { call("setup"); return false; }
        public function isServiceSupported(type:String):Boolean { return call("isServiceSupported", type) === true; }
        public function cleanup():void { call("cleanup"); }
        public function getProducts(ids:* = null, subscriptionIds:* = null, extra:* = null):Boolean { call("getProducts"); return false; }
        public function showProductView(id:* = null):Boolean { return false; }
        public function showProductOverlay(id:* = null, options:* = null):Boolean { return false; }
        public function dismissProductOverlay():void {}
        public function makePurchase(request:* = null):Boolean { call("makePurchase"); return false; }
        public function changePurchase(request:* = null):Boolean { return false; }
        public function finishPurchase(purchase:* = null):Boolean { call("finishPurchase"); return false; }
        public function consumePurchase(request:* = null):Boolean { call("consumePurchase"); return false; }
        public function consumePurchaseByProductId(id:* = null):Boolean { return false; }
        public function shouldAddPurchase(id:* = null, value:* = null):Boolean { return false; }
        public function checkPurchaseRequestValid(request:* = null):Boolean { return false; }
        public function getPurchases(ids:* = null):Boolean { call("getPurchases"); return false; }
        public function restorePurchases(options:* = null):void { call("restorePurchases"); }
        public function getPendingPurchases():Array { return []; }
        public function getUserData():Boolean { return false; }

        public function dispose():void {
            if (context != null) context.dispose();
            context = null;
            instance = null;
        }
    }
}
