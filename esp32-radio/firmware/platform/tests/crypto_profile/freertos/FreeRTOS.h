#pragma once
#include <assert.h>

typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
extern unsigned test_lock_depth;
#define portENTER_CRITICAL(lock)                                                                   \
    do {                                                                                           \
        (void)(lock);                                                                              \
        assert(test_lock_depth++ == 0);                                                            \
    } while (0)
#define portEXIT_CRITICAL(lock)                                                                    \
    do {                                                                                           \
        (void)(lock);                                                                              \
        assert(test_lock_depth-- == 1);                                                            \
    } while (0)

int xPortInIsrContext(void);
