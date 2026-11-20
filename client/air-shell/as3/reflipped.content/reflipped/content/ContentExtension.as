// The Reflipped app's own extension for the import build's loader (loader/ReflippedLoader.as) and importer
// (java/src/reflipped/shell/content/). GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package reflipped.content {
    import flash.external.ExtensionContext;

    /**
     * Hands out the ExtensionContext of "reflipped.content". AIR only lets an extension's own library.swf create its
     * context, so the loader is compiled against this library as an external one and uses this class at run time.
     */
    public class ContentExtension {
        public static const ID:String = "reflipped.content";

        public static function create():ExtensionContext {
            return ExtensionContext.createExtensionContext(ID, "");
        }
    }
}
