#!/usr/bin/env python3
"""New native-deployment regressions. Optional: --apk PATH --arch x64 verifies the real signed artifact too."""
import argparse
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reflipped_build", HERE.parent / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def dex(classes, defined=True):
    # A minimal structurally readable class table: verification depends on class_defs, not a loose byte search.
    data = bytearray(112)
    data[:8] = b"dex\n035\0"
    struct.pack_into("<I", data, 40, 0x12345678)
    string_offset = len(data)
    data.extend(b"\0" * (4 * len(classes)))
    type_offset = len(data)
    data.extend(b"".join(struct.pack("<I", i) for i in range(len(classes))))
    class_offset = len(data)
    if defined:
        for i in range(len(classes)):
            data.extend(struct.pack("<I", i) + b"\0" * 28)
    for i, name in enumerate(classes):
        struct.pack_into("<I", data, string_offset + i * 4, len(data))
        raw = name.encode()
        count = len(raw)
        while count >= 128:
            data.append((count & 127) | 128)
            count >>= 7
        data.append(count)
        data.extend(raw + b"\0")
    struct.pack_into("<II", data, 56, len(classes), string_offset)
    struct.pack_into("<II", data, 64, len(classes), type_offset)
    struct.pack_into("<II", data, 96, len(classes) if defined else 0, class_offset)
    return data


class PackagedExtensionsTest(unittest.TestCase):
    def package(self, file, arch="x64", fallback=False, defined=True, deployment=True):
        platform = build.ANDROID_PLATFORM_BY_ARCH[arch]
        with zipfile.ZipFile(file, "w") as z:
            classes = []
            for ext, (initializer, _) in build.EXTENSIONS.items():
                base = f"assets/META-INF/AIR/extensions/{ext}/META-INF/ANE/"
                z.writestr(base + ("default" if fallback else platform) + "/library.swf", b"wrapper")
                descriptor = build.extension_xml(ext, initializer, "classes.jar", "51.0")
                if not deployment:
                    descriptor = descriptor.replace(f"<initializer>{initializer}</initializer>", "")
                z.writestr(base + "extension.xml", descriptor)
                classes.append("L" + initializer.replace(".", "/") + ";")
            # Multidex is valid; the initializer is not required to live specifically in classes.dex.
            z.writestr("classes.dex", dex([]))
            z.writestr("classes2.dex", dex(classes, defined))

    def test_all_requested_architectures_have_native_platforms_and_defined_initializers(self):
        self.assertEqual(set(build.ANDROID_PLATFORMS), {"Android-ARM", "Android-ARM64", "Android-x86", "Android-x64"})
        with tempfile.TemporaryDirectory() as d:
            for arch in build.ANDROID_PLATFORM_BY_ARCH:
                file = Path(d) / f"{arch}.apk"
                self.package(file, arch)
                build.validate_packaged_extensions(file, arch)

    def test_default_fallback_is_rejected_even_if_dex_happens_to_have_native_classes(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "default.apk"
            self.package(file, fallback=True)
            with self.assertRaisesRegex(ValueError, "default fallback"):
                build.validate_packaged_extensions(file, "x64")

    def test_descriptor_without_initializer_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "missing-initializer.apk"
            self.package(file, deployment=False)
            with self.assertRaisesRegex(ValueError, "missing native initializer"):
                build.validate_packaged_extensions(file, "x64")

    def test_descriptor_strings_without_actual_dex_classes_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / "no-classes.apk"
            self.package(file, defined=False)
            with self.assertRaisesRegex(ValueError, "not defined"):
                build.validate_packaged_extensions(file, "x64")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk")
    parser.add_argument("--arch", default="x64", choices=list(build.ANDROID_PLATFORM_BY_ARCH))
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PackagedExtensionsTest)
    if not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful():
        raise SystemExit(1)
    if args.apk:
        build.validate_packaged_extensions(args.apk, args.arch)
        print(f"Packaged APK has native {build.ANDROID_PLATFORM_BY_ARCH[args.arch]} implementations and all Reflipped initializer classes")
