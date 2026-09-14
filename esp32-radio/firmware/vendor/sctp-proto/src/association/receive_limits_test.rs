use super::*;
use crate::ReceiveLimits;
use crate::packet::PartialDecode;

fn association(message: u32, bytes: u32, chunks: usize, streams: usize) -> Association {
    Association {
        state: AssociationState::Established,
        peer_last_tsn: 0,
        my_next_tsn: 1,
        source_port: 5000,
        destination_port: 5000,
        max_receive_buffer_size: bytes,
        max_receive_message_size: message,
        receive_limits: Some(ReceiveLimits::new(message, bytes, chunks, streams)),
        max_payload_size: 1200,
        ..Default::default()
    }
}

fn data(tsn: u32, stream: u16, ssn: u16, len: usize) -> ChunkPayloadData {
    ChunkPayloadData {
        tsn,
        stream_identifier: stream,
        stream_sequence_number: ssn,
        beginning_fragment: true,
        ending_fragment: true,
        payload_type: PayloadProtocolIdentifier::Binary,
        user_data: Bytes::from(vec![42; len]),
        ..Default::default()
    }
}

fn receive(a: &mut Association, chunk: ChunkPayloadData) {
    let packet = a.create_packet(vec![Box::new(chunk)]).marshal().unwrap();
    let partial = PartialDecode::unmarshal(&packet).unwrap();
    a.handle_event(AssociationEvent(AssociationEventInner::Datagram(
        Transmit {
            now: Instant::now(),
            remote: a.remote_addr,
            ecn: None,
            local_ip: None,
            payload: Payload::PartialDecode(partial),
        },
    )));
}

#[test]
fn policy_is_opt_in_and_preserves_high_stream_identifiers() {
    assert!(TransportConfig::default().receive_limits().is_none());
    let limits = ReceiveLimits::new(8192, 32768, 64, 8);
    let config = TransportConfig::default().with_receive_limits(limits);
    assert_eq!(config.max_receive_buffer_size(), 32768);
    assert_eq!(config.max_receive_message_size(), 8192);
    assert_eq!(config.max_num_inbound_streams(), u16::MAX);
    let overridden = config
        .with_max_receive_message_size(u32::MAX)
        .with_max_receive_buffer_size(u32::MAX);
    assert_eq!(overridden.max_receive_message_size(), 8192);
    assert_eq!(overridden.max_receive_buffer_size(), 32768);
    assert_eq!(
        overridden
            .with_max_receive_message_size(1024)
            .max_receive_message_size(),
        1024
    );
    let mut a = association(8192, 32768, 64, 8);
    for (n, stream) in [0, 64, 257, 32768, 65530, 65534, 4000, 5000]
        .into_iter()
        .enumerate()
    {
        a.handle_data(&data(n as u32 + 1, stream, 0, 1)).unwrap();
        assert!(a.stream(stream).unwrap().read().unwrap().is_some());
    }
    assert_eq!(a.streams.len(), 8);
    assert_eq!(
        a.handle_data(&data(9, 6000, 0, 1)).unwrap_err(),
        Error::ErrReceiveLimitExceeded
    );
    assert_eq!(a.streams.len(), 8);
    assert!(
        a.open_stream(65000, PayloadProtocolIdentifier::Binary)
            .is_err()
    );
}

#[test]
fn fragmented_message_limit_is_checked_before_reassembly_grows() {
    for unordered in [false, true] {
        let mut a = association(8192, 32768, 64, 8);
        for n in 0..8 {
            let mut chunk = data(n + 1, 65000, 0, 1024);
            chunk.unordered = unordered;
            chunk.beginning_fragment = n == 0;
            chunk.ending_fragment = false;
            a.handle_data(&chunk).unwrap();
        }
        assert_eq!(a.retained_receive_data(), (8192, 8));
        let mut tail = data(9, 65000, 0, 1);
        tail.unordered = unordered;
        tail.beginning_fragment = false;
        assert_eq!(
            a.handle_data(&tail).unwrap_err(),
            Error::ErrInboundPacketTooLarge
        );
        assert_eq!(a.retained_receive_data(), (8192, 8));
    }
}

#[test]
fn all_receive_queues_share_the_byte_and_fragment_budget() {
    let mut a = association(16, 32, 64, 8);
    // Complete data on an unordered stream can be consumed while a missing
    // earlier TSN keeps the same payload alive in the association queue.
    let mut first = data(2, 0, 0, 16);
    first.unordered = true;
    a.handle_data(&first).unwrap();
    assert_eq!(a.retained_receive_data(), (16, 1));
    drop(a.stream(0).unwrap().read().unwrap().unwrap());
    assert_eq!(a.get_my_receiver_window_credit(), 16);
    assert_eq!(a.retained_receive_data(), (16, 1));
    let mut second = data(3, 65000, 0, 16);
    second.ending_fragment = false;
    a.handle_data(&second).unwrap();
    assert_eq!(a.retained_receive_data(), (32, 2));
    // Missing TSNs are not allowed to bypass the hard resource budget.
    assert_eq!(
        a.handle_data(&data(1, 0, 1, 1)).unwrap_err(),
        Error::ErrReceiveLimitExceeded
    );
    assert_eq!(a.retained_receive_data(), (32, 2));
}

#[test]
fn missing_tsn_can_fill_a_gap_and_restore_receive_credit_within_the_budget() {
    let mut a = association(16, 32, 64, 8);
    let mut first = data(2, 0, 0, 8);
    first.unordered = true;
    a.handle_data(&first).unwrap();
    drop(a.stream(0).unwrap().read().unwrap().unwrap());
    assert_eq!(a.get_my_receiver_window_credit(), 24);
    let mut partial = data(3, 65000, 0, 8);
    partial.ending_fragment = false;
    a.handle_data(&partial).unwrap();
    assert_eq!(a.get_my_receiver_window_credit(), 16);
    a.handle_data(&data(1, 257, 0, 8)).unwrap();
    assert_eq!(a.peer_last_tsn, 3);
    assert!(a.payload_queue.is_empty());
    drop(a.stream(257).unwrap().read().unwrap().unwrap());
    assert_eq!(a.get_my_receiver_window_credit(), 24);
    let mut tail = data(4, 65000, 0, 8);
    tail.beginning_fragment = false;
    a.handle_data(&tail).unwrap();
    assert_eq!(a.stream(65000).unwrap().read().unwrap().unwrap().len(), 16);
    assert_eq!(a.retained_receive_data(), (0, 0));
    assert_eq!(a.get_my_receiver_window_credit(), 32);
    assert!(!a.is_closed());
}

#[test]
fn tiny_incomplete_messages_cannot_exhaust_chunk_metadata() {
    let mut a = association(8192, 32768, 64, 8);
    for n in 0..64 {
        let mut chunk = data(n + 1, 0, n as u16, 1);
        chunk.ending_fragment = false;
        a.handle_data(&chunk).unwrap();
    }
    assert_eq!(a.retained_receive_data(), (64, 64));
    assert_eq!(a.get_my_receiver_window_credit(), 0);
    assert_eq!(
        a.handle_data(&data(65, 0, 64, 1)).unwrap_err(),
        Error::ErrReceiveLimitExceeded
    );
    assert_eq!(a.retained_receive_data(), (64, 64));
}

#[test]
fn reset_deferred_data_is_counted_before_new_generation_is_readable() {
    let mut a = association(8, 16, 64, 8);
    a.handle_data(&data(1, 0, 0, 8)).unwrap();
    let reset: Box<dyn Param + Send + Sync> = Box::new(ParamOutgoingResetRequest {
        reconfig_request_sequence_number: 7,
        reconfig_response_sequence_number: u32::MAX,
        sender_last_tsn: 1,
        stream_identifiers: vec![0],
    });
    a.handle_reconfig_param(&reset, &mut vec![]).unwrap();
    assert!(a.retiring_streams.contains_key(&0));
    a.handle_data(&data(2, 0, 0, 8)).unwrap();
    assert!(a.deferred_reset_data.contains_key(&2));
    assert_eq!(a.retained_receive_data(), (16, 2));
    assert_eq!(
        a.handle_data(&data(3, 0, 1, 1)).unwrap_err(),
        Error::ErrReceiveLimitExceeded
    );
    assert_eq!(a.retained_receive_data(), (16, 2));
    drop(a.stream(0).unwrap().read().unwrap().unwrap());
    assert!(a.retained_receive_data().0 <= 8);
}

#[test]
fn compact_payloads_do_not_keep_unrelated_packet_bytes_alive() {
    let mut a = association(8, 16, 64, 8);
    let packet = Bytes::from(vec![42; 8192]);
    let mut chunk = data(2, 0, 0, 1);
    chunk.user_data = packet.slice(4000..4001);
    a.handle_data(&chunk).unwrap();
    let retained = &a.payload_queue.get(2).unwrap().user_data;
    assert_eq!(retained.as_ref(), chunk.user_data.as_ref());
    assert_ne!(retained.as_ptr(), chunk.user_data.as_ptr());
    let queued = &a.streams.get(&0).unwrap().reassembly_queue.ordered[0].chunks[0];
    assert_eq!(retained.as_ptr(), queued.user_data.as_ptr());
}

#[test]
fn overflow_on_the_wire_closes_the_association_and_fresh_peer_can_receive() {
    let mut a = association(8, 8, 2, 8);
    receive(&mut a, data(1, 0, 0, 8));
    assert!(!a.is_closed());
    receive(&mut a, data(2, 0, 1, 1));
    assert!(a.is_closed());
    assert!(core::iter::from_fn(|| a.poll()).any(|e| matches!(e, Event::AssociationLost { .. })));
    assert!(a.streams.is_empty());
    assert!(a.deferred_reset_data.is_empty());
    let mut fresh = association(8, 8, 2, 8);
    receive(&mut fresh, data(1, 65000, 0, 8));
    assert!(!fresh.is_closed());
    assert_eq!(
        fresh.stream(65000).unwrap().read().unwrap().unwrap().len(),
        8
    );
}
