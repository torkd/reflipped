package reflipped.shell.common;

public final class AddressCheckStateTest {
    private static void check(boolean value) { if (!value) throw new AssertionError(); }
    public static void main(String[] args) {
        AddressCheckState state = new AddressCheckState();
        int first = state.start();
        check(state.accept(first));
        state.edit();
        check(!state.accept(first));
        int second = state.start();
        int third = state.start();
        check(!state.accept(second));
        check(state.accept(third));
        state.close();
        check(!state.accept(third));
        System.out.println("Delayed server results cannot survive edits, newer checks or Back");
    }
}
