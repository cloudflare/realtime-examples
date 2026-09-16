use crate::{Error, Result};
use std::time::Instant;
use str0m::{
    Rtc,
    format::Codec,
    media::{Frequency, Mid},
    rtp::{RtpWrite, SeqNo},
};

/// One Opus packet per RTP packet, with sequence state tied to the SSRC lifetime.
#[derive(Debug)]
pub(crate) struct Audio {
    mid: Mid,
    next_seq: SeqNo,
}

impl Audio {
    pub(crate) fn new(mid: Mid) -> Self {
        Self {
            mid,
            // Match str0m's random initial sequence and start with a zero ROC.
            next_seq: SeqNo::default(),
        }
    }

    pub(crate) fn write(&mut self, rtc: &mut Rtc, pts_ms: u32, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > radio_core::music::MAX_OPUS_BYTES {
            return Err(Error::new("invalid Opus packet size"));
        }
        // Direct writes retain their payload, so never queue audio without a
        // live ICE/DTLS/SRTP transport to consume it.
        if !rtc.is_alive() || !rtc.is_connected() {
            return Err(Error::new("audio transport unavailable"));
        }
        let media = rtc
            .media(self.mid)
            .filter(|media| !media.disabled() && media.direction().is_sending())
            .ok_or(Error::new("audio media unavailable"))?;
        let pt = rtc
            .codec_config()
            .params()
            .iter()
            .find(|params| {
                let spec = params.spec();
                media.remote_pts().contains(&params.pt())
                    && spec.codec == Codec::Opus
                    && spec.clock_rate == Frequency::FORTY_EIGHT_KHZ
                    && spec.channels == Some(2)
            })
            .ok_or(Error::new("Opus was not negotiated"))?
            .pt();
        let mut direct = rtc.direct_api();
        let stream = direct
            .stream_tx_by_mid(self.mid, None)
            .ok_or(Error::new("audio stream unavailable"))?;

        // Pauses send encoded silence, without DTX/talkspurt markers. str0m
        // supplies negotiated header extensions, pacing and SRTP encryption.
        // The owned Arc payload outlives the caller's reusable music buffer.
        stream.write_rtp(RtpWrite::new(
            pt,
            self.next_seq.inc(),
            pts_ms.wrapping_mul(48),
            Instant::now(),
            bytes,
        ));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
