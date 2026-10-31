package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.distriqt.InAppBilling`: reports itself unsupported. Function names from tools/ane_calls.py. */
public class InAppBillingStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.InAppBilling";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(false, "isSupported", "isServiceSupported", "canMakePayments", "checkAvailability",
                "isChangePurchaseSupported", "isGetPurchasesSupported", "isProductOverlaySupported",
                "isProductViewSupported", "applicationReceipt_isSupported", "inAppUpdates_isSupported",
                "promotions_isSupported", "shouldAddPurchase");
        ctx.constant("0.0.0", "version");
        ctx.constant("reflipped", "implementation");
        ctx.noop("activeProductIds", "activeProducts", "changePurchase", "cleanup", "consumePurchase",
                "dismissProductOverlay", "finishPurchase", "getPendingPurchases", "getProducts", "getPurchases",
                "getUserData", "makePurchase", "restorePurchases", "setup", "showProductOverlay", "showProductView",
                "applicationReceipt_getAppReceipt", "applicationReceipt_refresh", "inAppUpdates_checkAppUpdate",
                "inAppUpdates_startAppUpdate", "promotions_getStoreOrder", "promotions_getStoreVisibility",
                "promotions_showCodeRedemptionDialog", "promotions_updateStoreOrder", "promotions_updateStoreVisibility");
    }
}
