/*
 * JNI launcher for the server on the phone (SH-13, docs/on-device-server.md): runs Node (libnode.so from nodejs-mobile)
 * in the local-server service's own process. GNU GPL version 3 with the additional permission in
 * client/air-shell/LICENSE.md.
 *
 * Built by tools/node_runtime.py with the host's clang and lld, without NDK headers or a sysroot: the few C library
 * functions used here are declared below and linked against generated stubs of libc.so and liblog.so, with
 * --no-undefined, so anything else the compiler would pull in fails the build.
 *
 * The Java side (reflipped.shell.service.NodeRunner) sets the environment with android.system.Os.setenv first:
 *   REFLIPPED_NODE_ARGS  Node's arguments after argv[0], one per line (e.g. options, then the script)
 *   REFLIPPED_NODE_CWD   the working directory (Java can't change it)
 *   REFLIPPED_NODE_LOG   optional file that also gets stdout and stderr, truncated here, up to LOG_FILE_CAP bytes
 * then calls NodeRunner.start(), which returns only when Node's event loop ends (an exit or an uncaught error ends
 * the whole process before that).
 */

typedef unsigned long size_t;
typedef long ssize_t;
typedef long pthread_t;
#define NULL ((void *)0)

extern int chdir(const char *path);
extern int close(int fd);
extern int dup2(int from, int to);
extern char *getenv(const char *name);
extern void *malloc(size_t size);
extern int open(const char *path, int flags, ...);
extern int pipe(int fds[2]);
extern int pthread_create(pthread_t *thread, const void *attr, void *(*run)(void *), void *arg);
extern int pthread_detach(pthread_t thread);
extern ssize_t read(int fd, void *buffer, size_t size);
extern size_t strlen(const char *text);
extern ssize_t write(int fd, const void *buffer, size_t size);
extern int __android_log_write(int priority, const char *tag, const char *text);
extern int __cxa_atexit(void (*run)(void *), void *arg, void *dso);
extern int usleep(unsigned int microseconds);

/* int node::Start(int argc, char** argv), exported by libnode.so; called by its mangled name, so no headers */
extern int _ZN4node5StartEiPPc(int argc, char **argv);

/* Linux open() flags, the same on every Android ABI */
#define O_WRONLY 01
#define O_CREAT 0100
#define O_TRUNC 01000
#define O_CLOEXEC 02000000
#define ANDROID_LOG_INFO 4
#define LOG_TAG "NodeJS"
#define LOG_FILE_CAP (1024 * 1024)

static int log_file = -1;
static long log_written = 0;
static volatile int pump_done = 0;

/* Copies Node's stdout and stderr to logcat, one line per entry, and into the log file while it is under its cap. */
static void *pump(void *arg) {
    int fd = (int)(long)arg;
    char line[1024];
    size_t used = 0;
    char chunk[512];
    ssize_t count;
    while ((count = read(fd, chunk, sizeof chunk)) > 0) {
        if (log_file >= 0 && log_written < LOG_FILE_CAP) {
            if (write(log_file, chunk, (size_t)count) > 0) log_written += count;
        }
        for (ssize_t i = 0; i < count; i++) {
            char c = chunk[i];
            if (c == '\n' || used == sizeof line - 1) {
                line[used] = 0;
                if (used > 0) __android_log_write(ANDROID_LOG_INFO, LOG_TAG, line);
                used = 0;
                if (c == '\n') continue;
            }
            line[used++] = c;
        }
    }
    if (used > 0) {
        line[used] = 0;
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, line);
    }
    pump_done = 1;
    return NULL;
}

/*
 * At exit (process.exit, or an uncaught error at start-up), the pump thread may not have copied Node's last words,
 * which are what explain a failed start. Close our ends of the pipe and give it up to half a second to finish.
 */
static void flush_output(void *unused) {
    (void)unused;
    close(1);
    close(2);
    for (int i = 0; i < 50 && !pump_done; i++) usleep(10000);
}

static int redirect_output(void) {
    int fds[2];
    pthread_t thread;
    if (pipe(fds) != 0) return -1;
    if (dup2(fds[1], 1) < 0 || dup2(fds[1], 2) < 0) return -1;
    close(fds[1]);
    if (pthread_create(&thread, NULL, pump, (void *)(long)fds[0]) != 0) return -1;
    pthread_detach(thread);
    __cxa_atexit(flush_output, NULL, NULL);
    return 0;
}

__attribute__((visibility("default")))
int Java_reflipped_shell_service_NodeRunner_start(void *env, void *clazz) {
    (void)env;
    (void)clazz;
    const char *args = getenv("REFLIPPED_NODE_ARGS");
    const char *cwd = getenv("REFLIPPED_NODE_CWD");
    const char *log_path = getenv("REFLIPPED_NODE_LOG");
    if (args == NULL) return -100;
    if (cwd != NULL && chdir(cwd) != 0) return -101;
    if (log_path != NULL && log_path[0] != 0)
        log_file = open(log_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (redirect_output() != 0) return -102;

    /* argv in one contiguous block, as Node expects (it may rewrite it for process.title) */
    size_t length = strlen(args);
    int argc = 1;
    for (size_t i = 0; i < length; i++)
        if (args[i] == '\n') argc++;
    argc++; /* argv[0] */
    char *block = malloc(5 + length + 1);
    char **argv = malloc(sizeof(char *) * (size_t)(argc + 1));
    if (block == NULL || argv == NULL) return -103;
    const char *name = "node";
    for (int i = 0; i < 5; i++) block[i] = name[i];
    argv[0] = block;
    int n = 1;
    char *at = block + 5;
    argv[n++] = at;
    for (size_t i = 0; i < length; i++) {
        if (args[i] == '\n') {
            *at++ = 0;
            argv[n++] = at;
        } else {
            *at++ = args[i];
        }
    }
    *at = 0;
    argv[n] = NULL;
    return _ZN4node5StartEiPPc(n, argv);
}
