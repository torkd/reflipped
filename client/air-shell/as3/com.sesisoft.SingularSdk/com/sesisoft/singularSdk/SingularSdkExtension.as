// The Reflipped app's own ActionScript side of the "com.sesisoft.SingularSdk" native extension, written from the game's call
// sites, not from the original wrapper. GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package com.sesisoft.singularSdk {
    import flash.external.ExtensionContext;

    /**
     * Hands out the ExtensionContext; the game calls the native functions on it itself, and our Java stub answers
     * them. AIR only lets an extension's own library.swf create its context, so this class has to be here even
     * though the game has a copy of it.
     */
    public class SingularSdkExtension {
        public static const ID:String = "com.sesisoft.SingularSdk";

        /** A new context for this extension; the game keeps the one it gets. */
        public static function create():ExtensionContext {
            return ExtensionContext.createExtensionContext(ID, "");
        }
    }
}
