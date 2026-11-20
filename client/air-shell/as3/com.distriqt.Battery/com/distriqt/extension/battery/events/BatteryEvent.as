// The Reflipped app's own ActionScript side of the "com.distriqt.Battery" native extension, written from the game's call
// sites, not from the original wrapper. GNU GPL version 3 with the additional permission in client/air-shell/LICENSE.md.
package com.distriqt.extension.battery.events {
    import flash.events.Event;

    /**
     * The battery reading the game draws its header gauge from. It must be defined in the extension's library: the
     * game's handler is typed with this class, and it resolves to the library's definition (the main application
     * domain, where AIR loads every extension library, is searched first).
     */
    public class BatteryEvent extends Event {
        public static const BATTERY_INFO:String = "battery:info";

        /** Percent, 0 to 100 (the game divides by 100). */
        public var batteryLevel:Number;
        /** Android BatteryManager status as our Java stub reports it (2 = charging). */
        public var batteryState:int;

        public function BatteryEvent(type:String, batteryLevel:Number = 0, batteryState:int = 0,
                                     bubbles:Boolean = false, cancelable:Boolean = false) {
            super(type, bubbles, cancelable);
            this.batteryLevel = batteryLevel;
            this.batteryState = batteryState;
        }

        override public function clone():Event {
            return new BatteryEvent(type, batteryLevel, batteryState, bubbles, cancelable);
        }
    }
}
