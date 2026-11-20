// The Reflipped app's own ActionScript side of the "com.digitalstrawberry.ane.share" native extension, written from the
// game's call sites, not from the original wrapper. GNU GPL version 3 with the additional permission in
// client/air-shell/LICENSE.md.
package com.digitalstrawberry.ane.share.events {
    import flash.events.Event;

    /** The result of a share. The game doesn't listen for it today. */
    public class ShareEvent extends Event {
        public static const COMPLETE:String = "ShareEvent::complete";
        public static const CANCEL:String = "ShareEvent::cancel";
        public static const ERROR:String = "ShareEvent::error";

        private var activity:String;
        private var message:String;

        public function ShareEvent(type:String, sharedActivity:String = null, errorMessage:String = null) {
            super(type);
            activity = sharedActivity;
            message = errorMessage;
        }

        public function get sharedActivity():String { return activity; }
        public function get errorMessage():String { return message; }

        override public function clone():Event {
            return new ShareEvent(type, activity, message);
        }
    }
}
