#include "platform.h"
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>

int process_identity(pid_t pid, char *birth, size_t size, pid_t *pgid) {
    struct proc_bsdinfo info;
    errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return errno == ESRCH ? 3 : 4;
    snprintf(birth, size, "%llu.%06llu", info.pbi_start_tvsec, info.pbi_start_tvusec);
    *pgid = (pid_t)info.pbi_pgid;
    return 0;
}

int boot_identity(char *boot, size_t size) {
    return sysctlbyname("kern.bootsessionuuid", boot, &size, NULL, 0) == 0 ? 0 : 4;
}
