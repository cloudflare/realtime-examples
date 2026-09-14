use crate::error::{Error, Result};
#[cfg(target_os = "espidf")]
use esp_idf_hal::{
    cpu::Core,
    task::thread::{MallocCap, ThreadSpawnConfiguration},
};
use std::{marker::PhantomData, rc::Rc};

/// Restores the creator's pthread settings after spawning a configured task.
#[derive(Debug)]
pub(crate) struct SpawnConfig {
    #[cfg(target_os = "espidf")]
    saved: ThreadSpawnConfiguration,
    _task: PhantomData<Rc<()>>,
}

impl SpawnConfig {
    pub(crate) fn radio() -> Result<Self> {
        Self::configure(2)
    }
    pub(crate) fn analysis() -> Result<Self> {
        Self::configure(0)
    }
    pub(crate) fn metrics() -> Result<Self> {
        Self::configure(1)
    }
    #[cfg(target_os = "espidf")]
    fn configure(role: u8) -> Result<Self> {
        let (name, stack_size, priority, core) = match role {
            0 => (c"analysis", 20_480, 4, Core::Core1),
            1 => (c"metrics", 8192, 2, Core::Core1),
            2 => (c"radio", 49_152, 5, Core::Core0),
            _ => return Err(Error::new("invalid task role")),
        };
        // HAL 0.46 can return a zeroed value if IDF cannot initialize pthread
        // storage. HAL rejects priority zero; use SDK defaults in that case.
        let saved = ThreadSpawnConfiguration::get()
            .filter(|config| config.priority != 0)
            .unwrap_or_default();
        ThreadSpawnConfiguration {
            name: Some(name),
            stack_size,
            priority,
            pin_to_core: Some(core),
            inherit: false,
            stack_alloc_caps: MallocCap::Internal | MallocCap::Cap8bit,
        }
        .set()
        .map_err(|error| Error::native("task configuration failed", error.code()))?;
        Ok(Self {
            saved,
            _task: PhantomData,
        })
    }

    // Host checks compile this error-returning stub. The target build compiles
    // the HAL path; device checks exercise task creation and configuration.
    #[cfg(not(target_os = "espidf"))]
    fn configure(_role: u8) -> Result<Self> {
        Err(Error::new("task configuration requires ESP-IDF"))
    }
}

#[cfg(target_os = "espidf")]
impl Drop for SpawnConfig {
    fn drop(&mut self) {
        self.saved.set().expect("cannot restore task configuration");
    }
}
