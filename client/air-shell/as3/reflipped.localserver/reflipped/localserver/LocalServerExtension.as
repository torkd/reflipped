// The Reflipped app's own extension "reflipped.localserver" (the server on the phone, SH-13). GNU GPL version 3 with
// the additional permission in client/air-shell/LICENSE.md.
package reflipped.localserver {
    import flash.external.ExtensionContext;

    /**
     * The game never opens this extension: it carries the server's native libraries and Java classes, which the
     * Kakao stub uses directly. Every extension needs a library, so this one only names it.
     */
    public class LocalServerExtension {
        public static const ID:String = "reflipped.localserver";

        public static function create():ExtensionContext {
            return ExtensionContext.createExtensionContext(ID, "");
        }
    }
}
