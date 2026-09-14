#include <stdio.h>
#include "radio_bridge.h"

void app_main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    radio_rust_main();
}
